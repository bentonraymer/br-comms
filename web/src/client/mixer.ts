// Audio output mixer. Web Audio mode gives per-person volume (works on iOS, where
// <audio>.volume is read-only). "Simple" mode plays plain <audio> elements as a fallback.

export type AudioMode = 'webaudio' | 'simple';

interface Node {
  el: HTMLAudioElement;
  src?: MediaStreamAudioSourceNode;
  gain?: GainNode;
}

let sharedCtx: AudioContext | null = null;

/** Create/resume the shared AudioContext. Call from a user gesture. */
export function unlockAudio(): AudioContext {
  if (!sharedCtx) {
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    sharedCtx = new Ctx({ latencyHint: 'interactive' });
  }
  if (sharedCtx.state !== 'running') void sharedCtx.resume();
  // iOS 17+: ask for a voice-chat audio session so Bluetooth headsets route both ways.
  const nav = navigator as Navigator & { audioSession?: { type: string } };
  if (nav.audioSession) {
    try {
      nav.audioSession.type = 'play-and-record';
    } catch {}
  }
  return sharedCtx;
}

export class Mixer {
  readonly ctx: AudioContext;
  private master: GainNode;
  private nodes = new Map<string, Node>();
  private volumes: Record<string, number>;
  private masterVol: number;

  constructor(private storageKey: string, public mode: AudioMode) {
    this.ctx = unlockAudio();
    this.master = this.ctx.createGain();
    this.master.connect(this.ctx.destination);
    this.volumes = load(storageKey, {});
    this.masterVol = load(`${storageKey}.master`, 1);
    this.master.gain.value = this.masterVol;
  }

  get running() {
    return this.ctx.state === 'running';
  }

  resume() {
    if (this.ctx.state !== 'running') void this.ctx.resume();
    for (const n of this.nodes.values()) if (n.el.paused) void n.el.play().catch(() => {});
  }

  add(slotId: string, track: MediaStreamTrack) {
    this.remove(slotId);
    const stream = new MediaStream([track]);
    const el = new Audio();
    el.autoplay = true;
    (el as HTMLAudioElement & { playsInline: boolean }).playsInline = true;
    el.srcObject = stream;
    const node: Node = { el };
    if (this.mode === 'webaudio') {
      // Chrome only feeds remote WebRTC audio into Web Audio if an element is also consuming it.
      el.muted = true;
      node.src = this.ctx.createMediaStreamSource(stream);
      node.gain = this.ctx.createGain();
      node.gain.gain.value = this.volume(slotId);
      node.src.connect(node.gain).connect(this.master);
    } else {
      el.volume = Math.min(1, this.volume(slotId) * this.masterVol);
    }
    void el.play().catch(() => {});
    this.nodes.set(slotId, node);
  }

  remove(slotId: string) {
    const n = this.nodes.get(slotId);
    if (!n) return;
    n.src?.disconnect();
    n.gain?.disconnect();
    n.el.pause();
    n.el.srcObject = null;
    this.nodes.delete(slotId);
  }

  removeAll() {
    for (const id of [...this.nodes.keys()]) this.remove(id);
  }

  volume(slotId: string) {
    return this.volumes[slotId] ?? 1;
  }

  setVolume(slotId: string, v: number) {
    this.volumes[slotId] = v;
    save(this.storageKey, this.volumes);
    const n = this.nodes.get(slotId);
    if (n?.gain) n.gain.gain.setTargetAtTime(v, this.ctx.currentTime, 0.02);
    else if (n) n.el.volume = Math.min(1, v * this.masterVol);
  }

  get masterVolume() {
    return this.masterVol;
  }

  setMaster(v: number) {
    this.masterVol = v;
    save(`${this.storageKey}.master`, v);
    this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.02);
    if (this.mode === 'simple') for (const [id, n] of this.nodes) n.el.volume = Math.min(1, this.volume(id) * v);
  }
}

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
function save(key: string, v: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {}
}
