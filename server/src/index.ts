import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import { config } from './config.ts';
import { Hub, HttpError } from './hub.ts';
import { initMedia } from './media.ts';
import { Store } from './store.ts';
import { randomToken, RateLimiter, safeEqual } from './util.ts';

const COOKIE = 'brc_session';
const SESSION_DAYS = 30;

async function main() {
  if (!config.sitePassword) {
    console.error('SITE_PASSWORD is required. Set it in your environment / docker-compose.yml.');
    process.exit(1);
  }

  const store = new Store(config.dataDir);
  const secret = config.sessionSecret || store.getMeta('session_secret') || randomToken(32);
  if (!config.sessionSecret) store.setMeta('session_secret', secret);

  const https =
    config.tlsCert && config.tlsKey
      ? { cert: fs.readFileSync(config.tlsCert), key: fs.readFileSync(config.tlsKey) }
      : null;

  // `https` is optional (direct TLS for LAN testing); typed as a plain HTTP instance.
  const app = Fastify({
    logger: { level: config.logLevel },
    trustProxy: true,
    bodyLimit: 64 * 1024,
    ...(https ? { https } : {}),
  } as { logger: { level: string }; trustProxy: boolean; bodyLimit: number });

  await app.register(fastifyCookie, { secret });
  await app.register(fastifyWebsocket, { options: { maxPayload: 256 * 1024 } });

  await initMedia((m) => app.log.info(m));
  const hub = new Hub(store, (m) => app.log.info(m));
  const loginLimiter = new RateLimiter(10, 60_000);

  // ---- auth helpers ----
  const sessionValid = (req: FastifyRequest) => {
    const raw = req.cookies[COOKIE];
    if (!raw) return false;
    const un = req.unsignCookie(raw);
    return un.valid && !!un.value && Number(un.value) > Date.now();
  };
  const requireSite = (req: FastifyRequest) => {
    if (!sessionValid(req)) throw new HttpError(401, 'Site password required');
  };
  /** Site session OR a valid room join token grants access to a room's join flow. */
  const requireRoomAccess = (req: FastifyRequest, roomId: string, t: unknown) => {
    const room = hub.requireRoom(roomId);
    if (sessionValid(req)) return room;
    if (typeof t === 'string' && t && safeEqual(t, room.joinToken)) return room;
    throw new HttpError(401, 'This link is invalid or has been replaced');
  };

  app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply: FastifyReply) => {
    const status = err instanceof HttpError ? err.status : (err.statusCode ?? 500);
    if (status >= 500) app.log.error(err);
    reply.status(status).send({ error: status >= 500 ? 'Server error' : err.message });
  });

  // ---- API ----
  app.get('/api/health', async () => ({ ok: true }));

  app.get('/api/session', async (req) => ({ authed: sessionValid(req) }));

  app.post('/api/login', async (req, reply) => {
    if (!loginLimiter.allow(req.ip)) throw new HttpError(429, 'Too many attempts, wait a minute');
    const { password } = (req.body ?? {}) as { password?: string };
    if (typeof password !== 'string' || !safeEqual(password, config.sitePassword)) {
      throw new HttpError(401, 'Wrong password');
    }
    const expires = Date.now() + SESSION_DAYS * 86400_000;
    reply.setCookie(COOKIE, String(expires), {
      signed: true, httpOnly: true, sameSite: 'lax', path: '/', secure: req.protocol === 'https',
      maxAge: SESSION_DAYS * 86400,
    });
    return { authed: true };
  });

  app.post('/api/logout', async (_req, reply) => {
    reply.clearCookie(COOKIE, { path: '/' });
    return { authed: false };
  });

  app.get('/api/rooms', async (req) => {
    requireSite(req);
    return hub.listRooms();
  });

  app.post('/api/rooms', async (req) => {
    requireSite(req);
    const b = (req.body ?? {}) as Record<string, unknown>;
    const { room, slot, token } = hub.createRoom({
      name: b.name, mode: b.mode, roles: b.roles, permanent: b.permanent,
      creatorName: b.creatorName, creatorRole: b.creatorRole,
    });
    return { roomId: room.id, joinToken: room.joinToken, slotId: slot.id, slotToken: token };
  });

  app.get('/api/rooms/:id', async (req) => {
    const { id } = req.params as { id: string };
    const room = requireRoomAccess(req, id, (req.query as { t?: string }).t);
    return hub.publicInfo(room);
  });

  app.post('/api/rooms/:id/join', async (req) => {
    const { id } = req.params as { id: string };
    const b = (req.body ?? {}) as Record<string, unknown>;
    requireRoomAccess(req, id, b.t);
    const { slot, token } = hub.joinRoom(id, { name: b.name, role: b.role, kind: b.kind });
    return { slotId: slot.id, slotToken: token };
  });

  app.post('/api/rooms/:id/reclaim', async (req) => {
    const { id } = req.params as { id: string };
    const b = (req.body ?? {}) as Record<string, unknown>;
    requireRoomAccess(req, id, b.t);
    const { slot, token } = hub.reclaimSlot(id, b.slotId);
    return { slotId: slot.id, slotToken: token };
  });

  /** Check whether a device's stored slot token is still valid. */
  app.get('/api/rooms/:id/me', async (req) => {
    const { id } = req.params as { id: string };
    hub.requireRoom(id);
    const token = req.headers['x-slot-token'];
    const slot = typeof token === 'string' ? hub.slotForToken(id, token) : undefined;
    if (!slot) throw new HttpError(404, 'Slot not found');
    return { slotId: slot.id, kind: slot.kind };
  });

  app.register(async (scope) => {
    scope.get('/ws', { websocket: true }, (socket, req) => {
      const q = req.query as { room?: string; token?: string };
      hub.attach(socket, String(q.room ?? ''), String(q.token ?? ''));
    });
  });

  // ---- static web app (SPA) ----
  const here = path.dirname(fileURLToPath(import.meta.url));
  const webDir = [path.join(here, 'web'), path.join(here, '../../dist/web')].find((d) => fs.existsSync(d));
  if (webDir) {
    await app.register(fastifyStatic, {
      root: webDir,
      setHeaders: (res, file) => {
        if (file.endsWith('index.html') || file.endsWith('sw.js')) res.header('Cache-Control', 'no-cache');
      },
    });
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api/') && !req.url.startsWith('/ws')) {
        return reply.header('Cache-Control', 'no-cache').sendFile('index.html');
      }
      reply.status(404).send({ error: 'Not found' });
    });
  } else {
    app.log.warn('web build not found; run `npm run build:web` (dev: use the Vite server)');
  }

  await app.listen({ port: config.port, host: config.host });

  const shutdown = async () => {
    await app.close();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
