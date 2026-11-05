import os from 'node:os';
import path from 'node:path';

function detectLanIp(): string {
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs ?? []) if (a.family === 'IPv4' && !a.internal) return a.address;
  }
  return '127.0.0.1';
}

const env = process.env;

export const config = {
  port: Number(env.PORT ?? 3000),
  host: env.HOST ?? '0.0.0.0',
  sitePassword: env.SITE_PASSWORD ?? '',
  sessionSecret: env.SESSION_SECRET ?? '',
  dataDir: path.resolve(env.DATA_DIR ?? './data'),
  /** Public IP or hostname clients use to reach the media port. */
  announcedAddress: env.ANNOUNCED_ADDRESS || env.ANNOUNCED_IP || detectLanIp(),
  announcedExplicit: !!(env.ANNOUNCED_ADDRESS || env.ANNOUNCED_IP),
  /** Single UDP + TCP port used for all WebRTC media. */
  rtcPort: Number(env.RTC_PORT ?? 40000),
  roomTtlHours: Number(env.ROOM_TTL_HOURS ?? 24),
  tlsCert: env.TLS_CERT_FILE ?? '',
  tlsKey: env.TLS_KEY_FILE ?? '',
  logLevel: env.LOG_LEVEL ?? 'info',
};
