import { useEffect, useState } from 'react';
import { slotLabel } from '../../../shared/protocol.ts';
import type { Intercom, IntercomState } from '../client/intercom.ts';
import { cx } from '../util.ts';

/** Program feed source screen: pick an input, watch the meter. Listen-only for everyone else. */
export function ProgramView({ ic, s }: { ic: Intercom; s: IntercomState }) {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState('');
  useEffect(() => {
    const load = () => navigator.mediaDevices.enumerateDevices().then((d) => setDevices(d.filter((x) => x.kind === 'audioinput')));
    void load();
    navigator.mediaDevices.addEventListener('devicechange', load);
    return () => navigator.mediaDevices.removeEventListener('devicechange', load);
  }, [s.micError]);

  const me = s.room?.slots.find((x) => x.id === s.me);
  const listeners = s.room?.slots.filter((x) => x.kind === 'user' && x.online).length ?? 0;
  const db = s.level > 0 ? 20 * Math.log10(s.level) : -Infinity;
  const pct = Math.max(0, Math.min(100, ((db + 60) / 60) * 100));

  return (
    <div className="page center">
      <div className="card narrow program">
        <div className="muted small">{s.room?.name}</div>
        <h2>
          <span className="tag">PGM</span> {me ? slotLabel(me) : 'Program feed'}
        </h2>
        <p className={cx('onair', s.conn === 'connected' && !s.micError && 'live')}>
          {s.micError ? 'No input' : s.conn === 'connected' ? 'Sending' : 'Connecting…'}
        </p>
        <div className="meter" aria-label="Input level">
          <div className={cx('meter-fill', db > -6 && 'hot')} style={{ width: `${pct}%` }} />
        </div>
        <label className="field">
          <span>Input device</span>
          <select
            value={deviceId}
            onChange={(e) => {
              setDeviceId(e.target.value);
              void ic.setInputDevice(e.target.value);
            }}
          >
            <option value="">Default</option>
            {devices.map((d) => (
              <option key={d.deviceId} value={d.deviceId}>{d.label || `Input ${d.deviceId.slice(0, 6)}`}</option>
            ))}
          </select>
        </label>
        {s.micError && <p className="error">{s.micError}</p>}
        {s.mediaError && <p className="error">{s.mediaError}</p>}
        <p className="muted small">
          {listeners} crew online. Crew turn this feed on with its Listen toggle. Echo cancellation and auto-gain are off
          for full-fidelity audio.
        </p>
        <button className="btn danger" onClick={() => confirm('Stop and remove this program feed?') && ic.leave()}>
          Stop feed
        </button>
      </div>
    </div>
  );
}
