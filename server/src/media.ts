// mediasoup worker / WebRtcServer setup. All media uses one UDP + one TCP port.
import dns from 'node:dns/promises';
import net from 'node:net';
import * as mediasoup from 'mediasoup';
import type { types } from 'mediasoup';
import { config } from './config.ts';

let worker: types.Worker;
let webRtcServer: types.WebRtcServer;

const mediaCodecs: types.RouterRtpCodecCapability[] = [
  { kind: 'audio', mimeType: 'audio/opus', clockRate: 48000, channels: 2, preferredPayloadType: 111 },
];

/** Browsers need a literal IP in ICE candidates, so resolve hostnames once at startup. */
async function resolveAnnounced(addr: string, log: (msg: string) => void): Promise<string> {
  if (net.isIP(addr)) return addr;
  const { address } = await dns.lookup(addr, { family: 4 });
  log(`media: resolved ${addr} -> ${address}`);
  return address;
}

export async function initMedia(log: (msg: string) => void) {
  const announced = await resolveAnnounced(config.announcedAddress, log);
  if (!config.announcedExplicit) {
    log(`media: ANNOUNCED_ADDRESS not set, guessing ${announced}. Set it to your server's public IP/hostname.`);
  }
  worker = await mediasoup.createWorker({ logLevel: 'warn' });
  worker.on('died', () => {
    console.error('mediasoup worker died, exiting');
    process.exit(1);
  });
  const listen = (protocol: 'udp' | 'tcp'): types.TransportListenInfo => ({
    protocol,
    ip: '0.0.0.0',
    announcedAddress: announced,
    port: config.rtcPort,
  });
  webRtcServer = await worker.createWebRtcServer({ listenInfos: [listen('udp'), listen('tcp')] });
  log(`media: ${announced}:${config.rtcPort} (udp+tcp), mediasoup ${mediasoup.version}`);
}

export function createRouter() {
  return worker.createRouter({ mediaCodecs });
}

export async function createTransport(router: types.Router) {
  return router.createWebRtcTransport({
    webRtcServer,
    enableUdp: true,
    enableTcp: true,
    preferUdp: true,
    initialAvailableOutgoingBitrate: 300_000,
  });
}

export function transportParams(t: types.WebRtcTransport) {
  return {
    id: t.id,
    iceParameters: t.iceParameters,
    iceCandidates: t.iceCandidates,
    dtlsParameters: t.dtlsParameters,
  };
}

export type { types };
