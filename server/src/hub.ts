// Room runtime: live peers, mediasoup consumer mesh, routing-driven flow gating, and WS actions.
import type { WebSocket } from 'ws';
import {
  Close, LIMITS, slotLabel, type Flows, type GroupView, type JoinMode, type RoomView, type SlotKind, type SlotView,
  type Stat, type TxState, type WsRequest,
} from '../../shared/protocol.ts';
import { computeFlows, flowKey, sanitizeRouting, type FlowKey, type RoutingContext } from '../../shared/routing.ts';
import { config } from './config.ts';
import { createRouter, createTransport, transportParams, type types } from './media.ts';
import type { Group, Room, Slot, Store } from './store.ts';
import { cleanStr, randomId, randomPin, randomToken, RateLimiter, sha256 } from './util.ts';

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}
export { HttpError };

interface Peer {
  slotId: string;
  ws: WebSocket;
  alive: boolean;
  sendTransport?: types.WebRtcTransport;
  recvTransport?: types.WebRtcTransport;
  producer?: types.Producer;
  rtpCapabilities?: types.RtpCapabilities;
  /** source slotId -> consumer on this peer's recv transport */
  consumers: Map<string, types.Consumer>;
  tx: TxState;
  stat: Stat;
  lastFlows: string;
}

interface Runtime {
  roomId: string;
  router?: Promise<types.Router>;
  peers: Map<string, Peer>;
  flows: Set<FlowKey>;
  lastTalker: Map<string, string>;
  idleTimer?: NodeJS.Timeout;
}

type Handler = (peer: Peer, rt: Runtime, data: any) => Promise<unknown> | unknown;

const pinLimiter = new RateLimiter(5, 60_000);

export class Hub {
  private runtimes = new Map<string, Runtime>();

  constructor(private store: Store, private log: (msg: string) => void) {
    setInterval(() => this.heartbeat(), 15_000).unref();
    setInterval(() => this.broadcastStats(), 3_000).unref();
    setInterval(() => this.sweep(), 60_000).unref();
    this.sweep();
  }

  // ---------------------------------------------------------------- domain (HTTP side)

  createRoom(input: {
    name: unknown; mode: unknown; roles: unknown; permanent: unknown; creatorName: unknown; creatorRole: unknown;
  }) {
    const name = cleanStr(input.name, LIMITS.roomName) ?? 'Comms';
    const mode: JoinMode = input.mode === 'role' || input.mode === 'both' ? input.mode : 'name';
    const roles = Array.isArray(input.roles)
      ? [...new Set(input.roles.map((r) => cleanStr(r, LIMITS.role)).filter((r): r is string => !!r))].slice(0, LIMITS.roles)
      : [];
    if (mode !== 'name' && roles.length === 0) throw new HttpError(400, 'Add at least one role');
    const now = Date.now();
    let id = randomId(6);
    while (this.store.rooms.has(id)) id = randomId(6);
    const room: Room = {
      id, name, mode, roles: mode === 'name' ? [] : roles, permanent: input.permanent === true,
      expiresAt: now + config.roomTtlHours * 3600_000, joinToken: randomToken(12), adminPin: randomPin(), createdAt: now,
    };
    const { name: cName, role: cRole } = this.validateIdentity(room, input.creatorName, input.creatorRole, 'user');
    this.store.saveRoom(room);
    const { slot, token } = this.newSlot(room, cName, cRole, 'user', true);
    this.log(`room ${room.id} created (${room.permanent ? 'permanent' : 'expiring'})`);
    return { room, slot, token };
  }

  joinRoom(roomId: string, input: { name: unknown; role: unknown; kind: unknown }) {
    const room = this.requireRoom(roomId);
    const kind: SlotKind = input.kind === 'program' ? 'program' : 'user';
    if (this.store.roomSlots(room.id).length >= LIMITS.slots) throw new HttpError(400, 'Room is full');
    const { name, role } = this.validateIdentity(room, input.name, input.role, kind);
    const res = this.newSlot(room, name, role, kind, false);
    this.broadcastState(room.id);
    return res;
  }

  reclaimSlot(roomId: string, slotId: unknown) {
    const room = this.requireRoom(roomId);
    const slot = typeof slotId === 'string' ? this.store.slots.get(slotId) : undefined;
    if (!slot || slot.roomId !== room.id) throw new HttpError(404, 'Slot not found');
    if (this.runtimes.get(room.id)?.peers.has(slot.id)) throw new HttpError(409, 'That person is currently online');
    const token = randomToken();
    slot.tokenHash = sha256(token);
    this.store.saveSlot(slot);
    return { slot, token };
  }

  publicInfo(room: Room) {
    const rt = this.runtimes.get(room.id);
    return {
      id: room.id, name: room.name, mode: room.mode, roles: room.roles, joinToken: room.joinToken,
      slots: this.store.roomSlots(room.id).map((s) => ({
        id: s.id, label: slotLabel(s), online: !!rt?.peers.has(s.id), kind: s.kind,
      })),
    };
  }

  listRooms() {
    return [...this.store.rooms.values()]
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((r) => {
        const slots = this.store.roomSlots(r.id);
        const rt = this.runtimes.get(r.id);
        return {
          id: r.id, name: r.name, permanent: r.permanent, expiresAt: r.expiresAt, joinToken: r.joinToken,
          online: rt ? rt.peers.size : 0, total: slots.length,
        };
      });
  }

  requireRoom(roomId: string): Room {
    const room = this.store.rooms.get(roomId);
    if (!room || this.isExpired(room)) throw new HttpError(404, 'Room not found or expired');
    return room;
  }

  slotForToken(roomId: string, token: string): Slot | undefined {
    return this.store.slotByToken(roomId, sha256(token));
  }

  private isExpired(r: Room) {
    return !r.permanent && r.expiresAt < Date.now();
  }

  private validateIdentity(room: Room, rawName: unknown, rawRole: unknown, kind: SlotKind) {
    const name = cleanStr(rawName, LIMITS.name);
    if (kind === 'program') return { name: name ?? 'Program', role: null };
    let role = cleanStr(rawRole, LIMITS.role);
    if (room.mode === 'name') role = null;
    if ((room.mode === 'name' || room.mode === 'both') && !name) throw new HttpError(400, 'Name is required');
    if (room.mode !== 'name') {
      if (!role) throw new HttpError(400, 'Role is required');
      if (!room.roles.includes(role)) throw new HttpError(400, 'Unknown role');
    }
    return { name: room.mode === 'role' ? null : name, role };
  }

  private newSlot(room: Room, name: string | null, role: string | null, kind: SlotKind, isAdmin: boolean) {
    const token = randomToken();
    const existing = this.store.roomSlots(room.id);
    const slot: Slot = {
      id: randomId(10), roomId: room.id, name, role, kind, tokenHash: sha256(token), isAdmin, locked: false,
      routing: { talk: kind === 'user' ? ['all'] : [], listen: {} },
      sort: existing.length ? Math.max(...existing.map((s) => s.sort)) + 1 : 0, createdAt: Date.now(),
    };
    this.store.saveSlot(slot);
    return { slot, token };
  }

  // ---------------------------------------------------------------- views

  private view(room: Room, forSlot: Slot): RoomView {
    const rt = this.runtimes.get(room.id);
    const slots: SlotView[] = this.store.roomSlots(room.id).map((s) => ({
      id: s.id, name: s.name, role: s.role, kind: s.kind, isAdmin: s.isAdmin, locked: s.locked,
      online: !!rt?.peers.has(s.id), routing: s.routing,
    }));
    const groups: GroupView[] = this.store.roomGroups(room.id).map((g) => ({ id: g.id, name: g.name, members: g.members }));
    return {
      id: room.id, name: room.name, mode: room.mode, roles: room.roles, permanent: room.permanent,
      expiresAt: room.expiresAt, joinToken: room.joinToken, adminPin: forSlot.isAdmin ? room.adminPin : undefined,
      groups, slots,
    };
  }

  broadcastState(roomId: string) {
    const rt = this.runtimes.get(roomId);
    const room = this.store.rooms.get(roomId);
    if (!rt || !room) return;
    for (const peer of rt.peers.values()) {
      const slot = this.store.slots.get(peer.slotId);
      if (slot) send(peer.ws, 'state', this.view(room, slot));
    }
    this.recompute(rt);
  }

  private broadcastStats() {
    for (const rt of this.runtimes.values()) {
      if (!rt.peers.size) continue;
      const stats: Record<string, Stat> = {};
      for (const p of rt.peers.values()) stats[p.slotId] = p.stat;
      for (const p of rt.peers.values()) send(p.ws, 'stats', stats);
    }
  }

  // ---------------------------------------------------------------- flows

  private routingContext(rt: Runtime): RoutingContext {
    return {
      slots: this.store.roomSlots(rt.roomId).map((s) => {
        const peer = rt.peers.get(s.id);
        return {
          id: s.id, kind: s.kind, role: s.role, routing: s.routing,
          online: !!peer, tx: peer?.tx ?? { general: false, direct: null },
        };
      }),
      groups: this.store.roomGroups(rt.roomId),
    };
  }

  private recompute(rt: Runtime) {
    const ctx = this.routingContext(rt);
    const flows = computeFlows(ctx);
    const kinds = new Map(ctx.slots.map((s) => [s.id, s.kind]));
    for (const f of flows) {
      if (!rt.flows.has(f)) {
        const [from, to] = f.split('>');
        if (kinds.get(from) === 'user') rt.lastTalker.set(to, from);
      }
    }
    rt.flows = flows;

    for (const listener of rt.peers.values()) {
      for (const [sourceId, consumer] of listener.consumers) {
        const want = flows.has(flowKey(sourceId, listener.slotId));
        if (want && consumer.paused) consumer.resume().catch(() => {});
        else if (!want && !consumer.paused) consumer.pause().catch(() => {});
      }
      const msg: Flows = { incoming: [], outgoing: [], lastTalker: rt.lastTalker.get(listener.slotId) ?? null };
      for (const f of flows) {
        const [from, to] = f.split('>');
        if (to === listener.slotId) msg.incoming.push(from);
        if (from === listener.slotId) msg.outgoing.push(to);
      }
      const key = JSON.stringify(msg);
      if (key !== listener.lastFlows) {
        listener.lastFlows = key;
        send(listener.ws, 'flows', msg);
      }
    }
  }

  // ---------------------------------------------------------------- connections

  private runtime(roomId: string): Runtime {
    let rt = this.runtimes.get(roomId);
    if (!rt) {
      rt = { roomId, peers: new Map(), flows: new Set(), lastTalker: new Map() };
      this.runtimes.set(roomId, rt);
    }
    if (rt.idleTimer) {
      clearTimeout(rt.idleTimer);
      rt.idleTimer = undefined;
    }
    return rt;
  }

  private router(rt: Runtime) {
    if (!rt.router) rt.router = createRouter();
    return rt.router;
  }

  attach(ws: WebSocket, roomId: string, token: string) {
    const room = this.store.rooms.get(roomId);
    const slot = room && !this.isExpired(room) ? this.slotForToken(roomId, token) : undefined;
    if (!room || !slot) {
      ws.close(Close.BadToken, 'invalid');
      return;
    }
    const rt = this.runtime(roomId);
    const existing = rt.peers.get(slot.id);
    if (existing) {
      existing.ws.close(Close.Replaced, 'replaced');
      this.cleanupPeer(rt, existing, false);
    }
    const peer: Peer = {
      slotId: slot.id, ws, alive: true, consumers: new Map(), tx: { general: false, direct: null },
      stat: { rtt: null, loss: null }, lastFlows: '',
    };
    rt.peers.set(slot.id, peer);

    ws.on('pong', () => (peer.alive = true));
    ws.on('message', (raw) => {
      peer.alive = true;
      let req: WsRequest;
      try {
        req = JSON.parse(String(raw));
      } catch {
        return;
      }
      void this.dispatch(peer, rt, req);
    });
    ws.on('close', () => {
      if (rt.peers.get(slot.id) === peer) this.cleanupPeer(rt, peer, true);
    });
    this.broadcastState(roomId);
  }

  private cleanupPeer(rt: Runtime, peer: Peer, broadcast: boolean) {
    if (rt.peers.get(peer.slotId) === peer) rt.peers.delete(peer.slotId);
    peer.sendTransport?.close();
    peer.recvTransport?.close();
    rt.lastTalker.delete(peer.slotId);
    if (broadcast) this.broadcastState(rt.roomId);
    if (rt.peers.size === 0) {
      rt.idleTimer = setTimeout(() => {
        if (rt.peers.size) return;
        rt.router?.then((r) => r.close()).catch(() => {});
        this.runtimes.delete(rt.roomId);
      }, 60_000);
    }
  }

  private heartbeat() {
    for (const rt of this.runtimes.values()) {
      for (const p of rt.peers.values()) {
        if (!p.alive) {
          p.ws.terminate();
          continue;
        }
        p.alive = false;
        try {
          p.ws.ping();
        } catch {}
      }
    }
  }

  private sweep() {
    for (const room of [...this.store.rooms.values()]) {
      if (this.isExpired(room)) {
        this.log(`room ${room.id} expired`);
        this.closeRoom(room.id);
      }
    }
  }

  closeRoom(roomId: string) {
    const rt = this.runtimes.get(roomId);
    if (rt) {
      for (const p of [...rt.peers.values()]) {
        p.ws.close(Close.RoomClosed, 'room closed');
        this.cleanupPeer(rt, p, false);
      }
      clearTimeout(rt.idleTimer);
      rt.router?.then((r) => r.close()).catch(() => {});
      this.runtimes.delete(roomId);
    }
    this.store.deleteRoom(roomId);
  }

  // ---------------------------------------------------------------- media handshake

  private async consume(rt: Runtime, listener: Peer, source: Peer) {
    if (!listener.recvTransport || !listener.rtpCapabilities || !source.producer) return;
    if (listener.slotId === source.slotId || listener.consumers.has(source.slotId)) return;
    const listenerSlot = this.store.slots.get(listener.slotId);
    if (listenerSlot?.kind !== 'user') return;
    const router = await this.router(rt);
    if (!router.canConsume({ producerId: source.producer.id, rtpCapabilities: listener.rtpCapabilities })) return;
    const consumer = await listener.recvTransport.consume({
      producerId: source.producer.id, rtpCapabilities: listener.rtpCapabilities, paused: true,
    });
    listener.consumers.set(source.slotId, consumer);
    const drop = () => {
      if (listener.consumers.get(source.slotId) === consumer) listener.consumers.delete(source.slotId);
      send(listener.ws, 'consumerClosed', { id: consumer.id });
    };
    consumer.on('producerclose', drop);
    consumer.on('transportclose', () => listener.consumers.delete(source.slotId));
    send(listener.ws, 'newConsumer', {
      id: consumer.id, producerId: source.producer.id, slotId: source.slotId, kind: consumer.kind,
      rtpParameters: consumer.rtpParameters,
    });
    if (rt.flows.has(flowKey(source.slotId, listener.slotId))) await consumer.resume();
  }

  // ---------------------------------------------------------------- request dispatch

  private async dispatch(peer: Peer, rt: Runtime, req: WsRequest) {
    const handler = this.handlers[req.type];
    try {
      if (!handler) throw new Error(`unknown request ${req.type}`);
      if (!this.store.slots.has(peer.slotId)) throw new Error('slot removed');
      const data = await handler(peer, rt, req.data ?? {});
      if (req.id) peer.ws.send(JSON.stringify({ id: req.id, ok: true, data }));
    } catch (err) {
      if (req.id) peer.ws.send(JSON.stringify({ id: req.id, ok: false, error: (err as Error).message }));
    }
  }

  private me(peer: Peer): Slot {
    const s = this.store.slots.get(peer.slotId);
    if (!s) throw new Error('slot removed');
    return s;
  }
  private room(rt: Runtime): Room {
    const r = this.store.rooms.get(rt.roomId);
    if (!r) throw new Error('room closed');
    return r;
  }
  private admin(peer: Peer): Slot {
    const s = this.me(peer);
    if (!s.isAdmin) throw new Error('Admin only');
    return s;
  }
  private target(rt: Runtime, slotId: unknown): Slot {
    const s = typeof slotId === 'string' ? this.store.slots.get(slotId) : undefined;
    if (!s || s.roomId !== rt.roomId) throw new Error('Unknown person');
    return s;
  }

  private handlers: Record<string, Handler> = {
    hello: async (peer, rt) => {
      const router = await this.router(rt);
      const slot = this.me(peer);
      return { me: slot.id, routerRtpCapabilities: router.rtpCapabilities, state: this.view(this.room(rt), slot) };
    },

    createTransport: async (peer, rt, d: { direction: 'send' | 'recv' }) => {
      const router = await this.router(rt);
      const t = await createTransport(router);
      if (d.direction === 'send') {
        peer.sendTransport?.close();
        peer.sendTransport = t;
      } else {
        peer.recvTransport?.close();
        peer.recvTransport = t;
        peer.consumers.clear();
      }
      return transportParams(t);
    },

    connectTransport: async (peer, _rt, d: { transportId: string; dtlsParameters: types.DtlsParameters }) => {
      const t = [peer.sendTransport, peer.recvTransport].find((t) => t?.id === d.transportId);
      if (!t) throw new Error('no transport');
      await t.connect({ dtlsParameters: d.dtlsParameters });
      return {};
    },

    produce: async (peer, rt, d: { kind: types.MediaKind; rtpParameters: types.RtpParameters }) => {
      if (!peer.sendTransport) throw new Error('no send transport');
      if (d.kind !== 'audio') throw new Error('audio only');
      peer.producer?.close();
      peer.producer = await peer.sendTransport.produce({ kind: 'audio', rtpParameters: d.rtpParameters });
      for (const other of rt.peers.values()) await this.consume(rt, other, peer);
      this.recompute(rt);
      return { id: peer.producer.id };
    },

    ready: async (peer, rt, d: { rtpCapabilities: types.RtpCapabilities }) => {
      peer.rtpCapabilities = d.rtpCapabilities;
      for (const other of rt.peers.values()) await this.consume(rt, peer, other);
      this.recompute(rt);
      return {};
    },

    tx: (peer, rt, d: Partial<TxState>) => {
      const slot = this.me(peer);
      if (slot.kind !== 'user') return {};
      peer.tx = {
        general: d.general === true,
        direct: typeof d.direct === 'string' && d.direct.length < 80 ? d.direct : null,
      };
      this.recompute(rt);
      return {};
    },

    stat: (peer, _rt, d: Partial<Stat>) => {
      const num = (v: unknown, max: number) => (typeof v === 'number' && isFinite(v) ? Math.max(0, Math.min(max, v)) : null);
      peer.stat = { rtt: num(d.rtt, 60_000), loss: num(d.loss, 1) };
      return {};
    },

    ping: (_peer, _rt, d: { t: number }) => ({ t: d.t }),

    setRouting: (peer, rt, d: { slotId?: string; routing: unknown }) => {
      const me = this.me(peer);
      const target = d.slotId ? this.target(rt, d.slotId) : me;
      if (target.id !== me.id && !me.isAdmin) throw new Error('Admin only');
      if (target.locked && !me.isAdmin) throw new Error('Your routing is locked by an admin');
      target.routing = sanitizeRouting(d.routing);
      this.store.saveSlot(target);
      this.broadcastState(rt.roomId);
      return {};
    },

    claimAdmin: (peer, rt, d: { pin: string }) => {
      const me = this.me(peer);
      if (!pinLimiter.allow(me.id)) throw new Error('Too many attempts, wait a minute');
      if (String(d.pin ?? '').trim() !== this.room(rt).adminPin) throw new Error('Wrong PIN');
      me.isAdmin = true;
      this.store.saveSlot(me);
      this.broadcastState(rt.roomId);
      return {};
    },

    updateSelf: (peer, rt, d: { name?: string; role?: string }) => {
      const me = this.me(peer);
      const room = this.room(rt);
      const id = this.validateIdentity(room, d.name ?? me.name, d.role ?? me.role, me.kind);
      me.name = id.name;
      me.role = id.role;
      this.store.saveSlot(me);
      this.broadcastState(rt.roomId);
      return {};
    },

    leave: (peer, rt) => {
      const me = this.me(peer);
      this.removeSlot(rt, me, Close.Kicked);
      return {};
    },

    // ---- admin ----

    setLocked: (peer, rt, d: { slotId: string; locked: boolean }) => {
      this.admin(peer);
      const t = this.target(rt, d.slotId);
      t.locked = !!d.locked;
      this.store.saveSlot(t);
      this.broadcastState(rt.roomId);
      return {};
    },

    setAdmin: (peer, rt, d: { slotId: string; isAdmin: boolean }) => {
      this.admin(peer);
      const t = this.target(rt, d.slotId);
      if (t.kind !== 'user') throw new Error('Program feeds cannot be admins');
      t.isAdmin = !!d.isAdmin;
      this.store.saveSlot(t);
      this.broadcastState(rt.roomId);
      return {};
    },

    updateSlot: (peer, rt, d: { slotId: string; name?: string; role?: string }) => {
      this.admin(peer);
      const t = this.target(rt, d.slotId);
      const id = this.validateIdentity(this.room(rt), d.name ?? t.name, d.role ?? t.role, t.kind);
      t.name = id.name;
      t.role = id.role;
      this.store.saveSlot(t);
      this.broadcastState(rt.roomId);
      return {};
    },

    kick: (peer, rt, d: { slotId: string }) => {
      this.admin(peer);
      this.removeSlot(rt, this.target(rt, d.slotId), Close.Kicked);
      return {};
    },

    updateRoom: (peer, rt, d: { name?: string; roles?: string[]; permanent?: boolean; extendHours?: number }) => {
      this.admin(peer);
      const room = this.room(rt);
      if (d.name !== undefined) room.name = cleanStr(d.name, LIMITS.roomName) ?? room.name;
      if (Array.isArray(d.roles) && room.mode !== 'name') {
        const roles = [...new Set(d.roles.map((r) => cleanStr(r, LIMITS.role)).filter((r): r is string => !!r))];
        if (!roles.length) throw new Error('Keep at least one role');
        room.roles = roles.slice(0, LIMITS.roles);
      }
      if (typeof d.permanent === 'boolean') room.permanent = d.permanent;
      if (typeof d.extendHours === 'number' && d.extendHours > 0 && d.extendHours <= 24 * 30) {
        room.expiresAt = Math.max(room.expiresAt, Date.now()) + d.extendHours * 3600_000;
      }
      if (!room.permanent && room.expiresAt < Date.now()) room.expiresAt = Date.now() + 3600_000;
      this.store.saveRoom(room);
      this.broadcastState(rt.roomId);
      return {};
    },

    rotateLink: (peer, rt) => {
      this.admin(peer);
      const room = this.room(rt);
      room.joinToken = randomToken(12);
      this.store.saveRoom(room);
      this.broadcastState(rt.roomId);
      return {};
    },

    rotatePin: (peer, rt) => {
      this.admin(peer);
      const room = this.room(rt);
      room.adminPin = randomPin();
      this.store.saveRoom(room);
      this.broadcastState(rt.roomId);
      return {};
    },

    saveGroup: (peer, rt, d: { id?: string; name: string; members: string[] }) => {
      this.admin(peer);
      const name = cleanStr(d.name, LIMITS.name);
      if (!name) throw new Error('Group name required');
      const valid = new Set(this.store.roomSlots(rt.roomId).filter((s) => s.kind === 'user').map((s) => s.id));
      const members = Array.isArray(d.members) ? [...new Set(d.members.filter((m) => valid.has(m)))] : [];
      const groups = this.store.roomGroups(rt.roomId);
      let g: Group | undefined = d.id ? groups.find((x) => x.id === d.id) : undefined;
      if (!g) {
        if (groups.length >= LIMITS.groups) throw new Error('Too many groups');
        g = { id: randomId(8), roomId: rt.roomId, name, members, sort: groups.length };
      }
      g.name = name;
      g.members = members;
      this.store.saveGroup(g);
      this.broadcastState(rt.roomId);
      return { id: g.id };
    },

    deleteGroup: (peer, rt, d: { id: string }) => {
      this.admin(peer);
      const g = this.store.groups.get(d.id);
      if (g?.roomId === rt.roomId) this.store.deleteGroup(g.id);
      this.broadcastState(rt.roomId);
      return {};
    },

    endRoom: (peer, rt) => {
      this.admin(peer);
      this.log(`room ${rt.roomId} ended by admin`);
      setImmediate(() => this.closeRoom(rt.roomId));
      return {};
    },
  };

  private removeSlot(rt: Runtime, slot: Slot, code: number) {
    const peer = rt.peers.get(slot.id);
    this.store.deleteSlot(slot.id);
    for (const g of this.store.roomGroups(rt.roomId)) {
      if (g.members.includes(slot.id)) {
        g.members = g.members.filter((m) => m !== slot.id);
        this.store.saveGroup(g);
      }
    }
    if (peer) {
      setImmediate(() => peer.ws.close(code, 'removed'));
      this.cleanupPeer(rt, peer, false);
    }
    this.broadcastState(rt.roomId);
  }
}

function send(ws: WebSocket, type: string, data: unknown) {
  if (ws.readyState === 1) ws.send(JSON.stringify({ type, data }));
}
