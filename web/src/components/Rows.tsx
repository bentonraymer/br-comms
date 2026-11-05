import { useRef } from 'react';
import type { Stat } from '../../../shared/protocol.ts';
import { cx } from '../util.ts';

export function quality(s: Stat | undefined): 'good' | 'fair' | 'poor' | 'unknown' {
  if (!s || s.rtt === null) return 'unknown';
  const loss = s.loss ?? 0;
  if (s.rtt > 400 || loss > 0.08) return 'poor';
  if (s.rtt > 180 || loss > 0.02) return 'fair';
  return 'good';
}

export function Quality({ stat }: { stat: Stat | undefined }) {
  const q = quality(stat);
  const title = stat?.rtt != null
    ? `${stat.rtt} ms${stat.loss != null ? ` · ${(stat.loss * 100).toFixed(1)}% loss` : ''}`
    : 'No data';
  return (
    <span className={cx('quality', q)} title={title} aria-label={`Connection ${q}: ${title}`}>
      <i /><i /><i />
    </span>
  );
}

/** Press-and-hold with a short delay so scrolling the list doesn't key the mic. */
export function useHold(onStart: () => void, onEnd: () => void, delay = 140) {
  const timer = useRef<number | null>(null);
  const active = useRef(false);
  const origin = useRef<{ x: number; y: number } | null>(null);
  const cancel = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    origin.current = null;
    if (active.current) {
      active.current = false;
      onEnd();
    }
  };
  return {
    onPointerDown: (e: React.PointerEvent) => {
      if (e.button !== 0) return;
      origin.current = { x: e.clientX, y: e.clientY };
      timer.current = window.setTimeout(() => {
        active.current = true;
        onStart();
      }, delay);
    },
    onPointerMove: (e: React.PointerEvent) => {
      const o = origin.current;
      if (o && !active.current && Math.hypot(e.clientX - o.x, e.clientY - o.y) > 10) cancel();
    },
    onPointerUp: cancel,
    onPointerCancel: cancel,
    onPointerLeave: cancel,
    onContextMenu: (e: React.MouseEvent) => e.preventDefault(),
  };
}

export interface RowProps {
  label: string;
  sub?: string;
  tag?: string;
  online?: boolean;
  stat?: Stat;
  incoming?: boolean;
  outgoing?: boolean;
  talk?: 'on' | 'via' | 'off' | null;
  listen?: boolean | null;
  disabled?: boolean;
  volume?: number;
  onVolume?: (v: number) => void;
  onTalk?: () => void;
  onListen?: () => void;
  onHoldStart?: () => void;
  onHoldEnd?: () => void;
  onMore?: () => void;
  directActive?: boolean;
}

export function TargetRow(p: RowProps) {
  const hold = useHold(p.onHoldStart ?? (() => {}), p.onHoldEnd ?? (() => {}));
  const holdable = !!p.onHoldStart;
  return (
    <li className={cx('row', p.incoming && 'incoming', p.outgoing && 'outgoing', p.online === false && 'offline', p.directActive && 'direct')}>
      <div className={cx('row-main', holdable && 'holdable')} {...(holdable ? hold : {})}>
        <div className="row-label">
          {p.online !== undefined && <span className={cx('dot', p.online ? 'on' : 'off')} />}
          <span className="name">{p.label}</span>
          {p.tag && <span className="tag">{p.tag}</span>}
        </div>
        <div className="row-sub">
          {p.incoming ? <b className="talking">Talking to you</b> : p.online === false ? 'Offline' : p.sub}
          {p.online && p.stat && <Quality stat={p.stat} />}
        </div>
      </div>
      <div className="row-actions">
        {p.listen !== undefined && p.listen !== null && (
          <button
            className={cx('tog listen', p.listen && 'on')}
            disabled={p.disabled}
            aria-pressed={p.listen}
            onClick={p.onListen}
          >
            Listen
          </button>
        )}
        {p.talk !== undefined && p.talk !== null && (
          <button
            className={cx('tog talk', p.talk === 'on' && 'on', p.talk === 'via' && 'via')}
            disabled={p.disabled}
            aria-pressed={p.talk !== 'off'}
            onClick={p.onTalk}
          >
            Talk
          </button>
        )}
        {p.onMore && (
          <button className="more" aria-label="More" onClick={p.onMore}>⋯</button>
        )}
      </div>
      {p.onVolume && (
        <input
          className="vol"
          type="range"
          min={0}
          max={2}
          step={0.05}
          value={p.volume ?? 1}
          aria-label={`Volume for ${p.label}`}
          onChange={(e) => p.onVolume!(Number(e.target.value))}
        />
      )}
    </li>
  );
}
