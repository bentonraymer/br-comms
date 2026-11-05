// Connection to a room: WebSocket signaling, mediasoup transports, mic, mixer, stats, wake lock.
import { Device, type types } from 'mediasoup-client';
import {
  Close, type Flows, type RoomView, type Routing, type SlotKind, type Stat, type TxState, type WsNotify, type WsResponse,
} from '../../../shared/protocol.ts';
import { Mixer, type AudioMode } from './mixer.ts';

export type ConnState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'ended';
export type EndReason = 'kicked' | 'closed' | 'replaced' | 'invalid' | 'left';

export interface IntercomState {
  conn: ConnState;
  endReason?: EndReason;
  me: string | null;
  room: RoomView | null;
  flows: Flows;
  stats: Record<string, Stat>;
  micError: string | null;
  mediaError: string | null;
  audioRunning: boolean;
  wakeLock: boolean;
  /** Local mic level 0..1 (program feeds only, updated ~10x/s). */
  level: number;
}

const RELEASE_TAIL_MS = 150;

export class Intercom {
  state: IntercomState = {
    conn: 'idle', me: null, room: null, flows: { incoming: [], outgoing: [], lastTalker: null }, stats: {},
    micError: null, mediaError: null, audioRunning: false, wakeLock: false, level: 0,
  };
  readonly mixer: Mixer;
  private subs = new Set<() => void>();
  private ws: WebSocket | null = null;
  private reqId = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private sendT: types.Transport | null = null;
  private recvT: types.Transport | null = null;
  private producer: types.Producer | null = null;
  private consumers = new Map<string, { consumer: types.Consumer; slotId: string }>();
  private mic: MediaStream | null = null;
  private tx: TxState = { general: false, direct: null };
  private releaseTimer: number | null = null;
  private retry = 0;
  private retryTimer: number | null = null;
  private timers: number[] = [];
  private wakeLock: WakeLockSentinel | null = null;
  private stopped = false;
  private lastRecv = { lost: 0, received: 0 };
  private inputDeviceId: string | null = null;

  constructor(readonly roomId: string, private token: string, readonly kind: SlotKind, audioMode: AudioMode) {
    this.mixer = new Mixer(`brc.vol.${roomId}`, audioMode);
  }

  // ---------------------------------------------------------------- subscription
  subscribe(fn: () => void) {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }
  private set(patch: Partial<IntercomState>) {
    this.state = { ...this.state, ...patch };
    for (const fn of this.subs) fn();
  }

  // ---------------------------------------------------------------- lifecycle
  /** Must be called from a user gesture (unlocks audio). */
  async start() {
    this.stopped = false;
    this.mixer.resume();
    this.set({ audioRunning: this.mixer.running, conn: 'connecting' });
    this.ctxWatch();
    await this.openMic();
    void this.requestWakeLock();
    this.connect();
    this.timers.push(window.setInterval(() => this.pingAndStats(), 2500));
    document.addEventListener('visibilitychange', this.onVisible);
    window.addEventListener('online', this.onOnline);
  }

  stop(reason?: EndReason) {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    document.removeEventListener('visibilitychange', this.onVisible);
    window.removeEventListener('online', this.onOnline);
    this.teardownMedia();
    this.ws?.close(1000);
    this.ws = null;
    this.mic?.getTracks().forEach((t) => t.stop());
    this.mic = null;
    void this.wakeLock?.release().catch(() => {});
    this.wakeLock = null;
    this.set({ conn: 'ended', endReason: reason ?? this.state.endReason, wakeLock: false });
  }

  private ctxWatch() {
    this.mixer.ctx.onstatechange = () => this.set({ audioRunning: this.mixer.running });
  }

  private onVisible = () => {
    if (document.visibilityState !== 'visible') return;
    this.mixer.resume();
    void this.requestWakeLock();
    if (!this.ws || this.ws.readyState > 1) this.reconnectNow();
  };
  private onOnline = () => this.reconnectNow();

  /** Re-unlock audio after iOS interruptions; call from any tap. */
  poke() {
    if (!this.mixer.running) this.mixer.resume();
  }

  private async requestWakeLock() {
    try {
      if (!('wakeLock' in navigator) || this.wakeLock) return;
      this.wakeLock = await navigator.wakeLock.request('screen');
      this.set({ wakeLock: true });
      this.wakeLock.addEventListener('release', () => {
        this.wakeLock = null;
        this.set({ wakeLock: false });
      });
    } catch {
      this.set({ wakeLock: false });
    }
  }

  // ---------------------------------------------------------------- mic
  private constraints(deviceId: string | null): MediaTrackConstraints {
    const program = this.kind === 'program';
    return {
      ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
      echoCancellation: !program,
      noiseSuppression: !program,
      autoGainControl: !program,
      channelCount: program ? 2 : 1,
    };
  }

  private async openMic() {
    try {
      this.mic = await navigator.mediaDevices.getUserMedia({ audio: this.constraints(this.inputDeviceId), video: false });
      this.set({ micError: null });
      if (this.kind === 'program') this.startLevelMeter();
    } catch (err) {
      const e = err as DOMException;
      const msg = !window.isSecureContext
        ? 'Microphone needs HTTPS. Open this site over https://'
        : e.name === 'NotAllowedError'
          ? 'Microphone permission denied. Allow it in your browser settings and reload.'
          : `Microphone unavailable: ${e.message || e.name}`;
      this.set({ micError: msg });
    }
  }

  async setInputDevice(deviceId: string) {
    this.inputDeviceId = deviceId;
    const old = this.mic;
    await this.openMic();
    const track = this.mic?.getAudioTracks()[0];
    if (track && this.producer) await this.producer.replaceTrack({ track });
    old?.getTracks().forEach((t) => t.stop());
  }

  private levelTimer: number | null = null;
  private startLevelMeter() {
    if (!this.mic) return;
    if (this.levelTimer) clearInterval(this.levelTimer);
    const src = this.mixer.ctx.createMediaStreamSource(this.mic);
    const an = this.mixer.ctx.createAnalyser();
    an.fftSize = 512;
    src.connect(an);
    const buf = new Float32Array(an.fftSize);
    this.levelTimer = window.setInterval(() => {
      an.getFloatTimeDomainData(buf);
      let peak = 0;
      for (const v of buf) peak = Math.max(peak, Math.abs(v));
      this.set({ level: peak });
    }, 100);
    this.timers.push(this.levelTimer);
  }

  // ---------------------------------------------------------------- signaling
  private connect() {
    if (this.stopped) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws?room=${encodeURIComponent(this.roomId)}&token=${encodeURIComponent(this.token)}`);
    this.ws = ws;
    ws.onopen = () => {
      this.handshake().catch((err) => {
        this.set({ mediaError: `Audio connection failed: ${(err as Error).message}` });
        ws.close();
      });
    };
    ws.onmessage = (ev) => this.onMessage(JSON.parse(ev.data));
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.ws = null;
      for (const p of this.pending.values()) p.reject(new Error('disconnected'));
      this.pending.clear();
      this.teardownMedia();
      const end: Record<number, EndReason> = {
        [Close.BadToken]: 'invalid', [Close.Kicked]: 'kicked', [Close.RoomClosed]: 'closed', [Close.Replaced]: 'replaced',
      };
      if (end[ev.code]) {
        this.stop(this.state.endReason === 'left' ? 'left' : end[ev.code]);
        return;
      }
      if (this.stopped) return;
      this.set({ conn: 'reconnecting' });
      const delay = Math.min(8000, 500 * 2 ** this.retry++);
      this.retryTimer = window.setTimeout(() => this.connect(), delay);
    };
  }

  private reconnectNow() {
    if (this.stopped || (this.ws && this.ws.readyState <= 1)) return;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retry = 0;
    this.connect();
  }

  request<T = any>(type: string, data?: unknown): Promise<T> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== 1) return reject(new Error('Not connected'));
      const id = ++this.reqId;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, type, data }));
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error('Request timed out'));
      }, 10_000);
    });
  }

  private onMessage(msg: WsResponse & WsNotify) {
    if (typeof msg.id === 'number' && 'ok' in msg) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.ok) p.resolve(msg.data);
      else p.reject(new Error(msg.error));
      return;
    }
    switch (msg.type) {
      case 'state':
        this.set({ room: msg.data as RoomView });
        break;
      case 'flows':
        this.set({ flows: msg.data as Flows });
        break;
      case 'stats':
        this.set({ stats: msg.data as Record<string, Stat> });
        break;
      case 'newConsumer':
        void this.onNewConsumer(msg.data as any);
        break;
      case 'consumerClosed': {
        const { id } = msg.data as { id: string };
        const c = this.consumers.get(id);
        if (c) {
          c.consumer.close();
          this.mixer.remove(c.slotId);
          this.consumers.delete(id);
        }
        break;
      }
    }
  }

  // ---------------------------------------------------------------- media
  private async handshake() {
    const hello = await this.request<{ me: string; routerRtpCapabilities: types.RtpCapabilities; state: RoomView }>('hello');
    this.set({ me: hello.me, room: hello.state, conn: 'connecting', mediaError: null });

    const device = await Device.factory();
    await device.load({ routerRtpCapabilities: hello.routerRtpCapabilities });

    // Send transport + producer
    const sp = await this.request('createTransport', { direction: 'send' });
    const sendT = device.createSendTransport(sp);
    this.sendT = sendT;
    sendT.on('connect', ({ dtlsParameters }, cb, eb) => {
      this.request('connectTransport', { transportId: sendT.id, dtlsParameters }).then(() => cb(), eb);
    });
    sendT.on('produce', ({ kind, rtpParameters }, cb, eb) => {
      this.request<{ id: string }>('produce', { kind, rtpParameters }).then(({ id }) => cb({ id }), eb);
    });
    sendT.on('connectionstatechange', (s) => this.onTransportState(s));

    // Recv transport
    const rp = await this.request('createTransport', { direction: 'recv' });
    const recvT = device.createRecvTransport(rp);
    this.recvT = recvT;
    recvT.on('connect', ({ dtlsParameters }, cb, eb) => {
      this.request('connectTransport', { transportId: recvT.id, dtlsParameters }).then(() => cb(), eb);
    });
    recvT.on('connectionstatechange', (s) => this.onTransportState(s));

    const track = this.mic?.getAudioTracks()[0];
    if (track) {
      const program = this.kind === 'program';
      this.producer = await sendT.produce({
        track,
        stopTracks: false,
        zeroRtpOnPause: true,
        codecOptions: program
          ? { opusStereo: true, opusDtx: false, opusFec: true, opusMaxAverageBitrate: 128_000 }
          : { opusStereo: false, opusDtx: true, opusFec: true, opusMaxAverageBitrate: 32_000, opusPtime: 20 },
      });
      if (!program && !this.transmitting) this.producer.pause();
    }

    await this.request('ready', { rtpCapabilities: device.rtpCapabilities });
    await this.request('tx', this.tx);
    this.retry = 0;
    this.set({ conn: 'connected' });
  }

  private onTransportState(s: string) {
    if (s === 'failed') {
      this.set({ mediaError: 'Audio path failed (firewall/UDP blocked?). Retrying…' });
      this.ws?.close();
    } else if (s === 'connected') {
      this.set({ mediaError: null });
    }
  }

  private async onNewConsumer(d: { id: string; producerId: string; slotId: string; kind: types.MediaKind; rtpParameters: types.RtpParameters }) {
    if (!this.recvT) return;
    const consumer = await this.recvT.consume({ id: d.id, producerId: d.producerId, kind: d.kind, rtpParameters: d.rtpParameters });
    this.consumers.set(d.id, { consumer, slotId: d.slotId });
    this.mixer.add(d.slotId, consumer.track);
  }

  private teardownMedia() {
    for (const { consumer, slotId } of this.consumers.values()) {
      consumer.close();
      this.mixer.remove(slotId);
    }
    this.consumers.clear();
    this.producer?.close();
    this.producer = null;
    this.sendT?.close();
    this.recvT?.close();
    this.sendT = this.recvT = null;
  }

  // ---------------------------------------------------------------- talk
  private get transmitting() {
    return this.tx.general || !!this.tx.direct;
  }

  /** Update transmit state. Keying up is immediate; release has a short tail so last syllables aren't clipped. */
  setTx(next: TxState) {
    const wasOn = this.transmitting;
    const willOn = next.general || !!next.direct;
    if (this.releaseTimer) {
      clearTimeout(this.releaseTimer);
      this.releaseTimer = null;
    }
    const apply = () => {
      this.tx = next;
      if (this.kind !== 'program' && this.producer) {
        if (this.transmitting) this.producer.resume();
        else this.producer.pause();
      }
      this.request('tx', next).catch(() => {});
    };
    if (wasOn && !willOn) this.releaseTimer = window.setTimeout(apply, RELEASE_TAIL_MS);
    else apply();
    if (!wasOn && willOn) navigator.vibrate?.(12);
  }

  // ---------------------------------------------------------------- stats
  private async pingAndStats() {
    if (!this.ws || this.ws.readyState !== 1) return;
    const t0 = performance.now();
    let rtt: number | null = null;
    try {
      await this.request('ping', { t: t0 });
      rtt = Math.round(performance.now() - t0);
    } catch {}
    let loss: number | null = null;
    try {
      if (this.recvT) {
        let lost = 0;
        let received = 0;
        const report = await this.recvT.getStats();
        report.forEach((s: any) => {
          if (s.type === 'inbound-rtp' && s.kind === 'audio') {
            lost += s.packetsLost ?? 0;
            received += s.packetsReceived ?? 0;
          }
        });
        const dl = lost - this.lastRecv.lost;
        const dr = received - this.lastRecv.received;
        this.lastRecv = { lost, received };
        if (dr + dl > 20) loss = Math.max(0, dl) / (dr + Math.max(0, dl));
      }
    } catch {}
    this.request('stat', { rtt, loss }).catch(() => {});
  }

  // ---------------------------------------------------------------- actions
  setRouting(routing: Routing, slotId?: string) {
    return this.request('setRouting', { slotId, routing });
  }

  leave() {
    this.set({ endReason: 'left' });
    return this.request('leave').catch(() => {}).finally(() => this.stop('left'));
  }
}
