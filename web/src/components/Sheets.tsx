import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { slotLabel, type GroupView, type RoomView, type SlotView } from '../../../shared/protocol.ts';
import { joinUrl, pref, setPref } from '../api.ts';
import type { Intercom } from '../client/intercom.ts';
import { cx, expiryText } from '../util.ts';

export function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" role="dialog" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <h2>{title}</h2>
          <button className="btn ghost small" onClick={onClose}>Done</button>
        </div>
        <div className="sheet-body">{children}</div>
      </div>
    </div>
  );
}

function useAction(ic: Intercom) {
  const [err, setErr] = useState('');
  const run = (type: string, data?: unknown): Promise<boolean> =>
    ic.request(type, data).then(
      () => (setErr(''), true),
      (e: Error) => (setErr(e.message), false),
    );
  return { err, run };
}

// ------------------------------------------------------------------ share

export function SharePanel({ room }: { room: RoomView }) {
  const url = joinUrl(room.id, room.joinToken);
  const [qr, setQr] = useState('');
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    QRCode.toDataURL(url, { margin: 1, width: 480, color: { dark: '#000000', light: '#ffffff' } }).then(setQr, () => {});
  }, [url]);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {}
  };
  return (
    <section className="panel">
      <h3>Invite</h3>
      {qr && <img className="qr" src={qr} alt="Join QR code" />}
      <div className="linkbox">{url}</div>
      <div className="btn-row">
        <button className="btn" onClick={copy}>{copied ? 'Copied' : 'Copy link'}</button>
        {'share' in navigator && (
          <button className="btn" onClick={() => navigator.share({ title: room.name, url }).catch(() => {})}>Share…</button>
        )}
      </div>
      <p className="muted small">Anyone with this link can join without the site password.</p>
    </section>
  );
}

// ------------------------------------------------------------------ menu

export function MenuSheet({ ic, room, me, onClose, onEditGroup }: {
  ic: Intercom; room: RoomView; me: SlotView; onClose: () => void; onEditGroup: (g: GroupView | 'new') => void;
}) {
  const { err, run } = useAction(ic);
  const [pin, setPin] = useState('');
  const [master, setMaster] = useState(ic.mixer.masterVolume);
  const [audioMode, setAudioMode] = useState(pref<'webaudio' | 'simple'>('audioMode', 'webaudio'));
  const [myName, setMyName] = useState(me.name ?? '');
  const [myRole, setMyRole] = useState(me.role ?? '');
  const [roomName, setRoomName] = useState(room.name);
  const [rolesText, setRolesText] = useState(room.roles.join(', '));
  const [confirmEnd, setConfirmEnd] = useState(false);
  const usesName = room.mode !== 'role' || me.kind === 'program';
  const usesRole = room.mode !== 'name' && me.kind === 'user';

  return (
    <Sheet title="Menu" onClose={onClose}>
      <SharePanel room={room} />

      {me.kind === 'user' && (
        <section className="panel">
          <h3>Audio</h3>
          <label className="field">
            <span>Master volume</span>
            <input type="range" min={0} max={2} step={0.05} value={master}
              onChange={(e) => {
                const v = Number(e.target.value);
                setMaster(v);
                ic.mixer.setMaster(v);
              }} />
          </label>
          <label className="check">
            <input type="checkbox" checked={audioMode === 'simple'}
              onChange={(e) => {
                const m = e.target.checked ? 'simple' : 'webaudio';
                setAudioMode(m);
                setPref('audioMode', m);
              }} />
            <span>
              Compatibility audio
              <small className="muted"> — try if you hear nothing. Disables per-person volume on iPhone. Reload to apply.</small>
            </span>
          </label>
          <p className="muted small">
            Screen wake lock: {ic.state.wakeLock ? 'on' : 'unavailable'}. Keep this tab in front — phones may pause audio when locked
            or in the background.
          </p>
        </section>
      )}

      <section className="panel">
        <h3>You</h3>
        {usesName && (
          <label className="field">
            <span>Name</span>
            <input value={myName} maxLength={40} onChange={(e) => setMyName(e.target.value)} />
          </label>
        )}
        {usesRole && (
          <label className="field">
            <span>Role</span>
            <select value={myRole} onChange={(e) => setMyRole(e.target.value)}>
              {room.roles.map((r) => <option key={r}>{r}</option>)}
            </select>
          </label>
        )}
        <div className="btn-row">
          <button className="btn" onClick={() => run('updateSelf', { name: myName, role: myRole })}>Save</button>
        </div>
        {!me.isAdmin && me.kind === 'user' && (
          <div className="row-input">
            <input inputMode="numeric" placeholder="Admin PIN" value={pin} onChange={(e) => setPin(e.target.value)} />
            <button className="btn" onClick={() => run('claimAdmin', { pin })}>Become admin</button>
          </div>
        )}
        <div className="btn-row">
          <button className="btn danger" onClick={() => confirm('Leave and give up your slot?') && ic.leave()}>
            Leave room
          </button>
        </div>
      </section>

      {me.isAdmin && (
        <section className="panel">
          <h3>Admin</h3>
          <p>
            Admin PIN: <b className="mono">{room.adminPin}</b>{' '}
            <button className="btn ghost small" onClick={() => run('rotatePin')}>New PIN</button>
          </p>
          <p className="muted small">Share the PIN with anyone who should be able to become admin (e.g. if your phone dies).</p>

          <label className="field">
            <span>Room name</span>
            <div className="row-input">
              <input value={roomName} maxLength={60} onChange={(e) => setRoomName(e.target.value)} />
              <button className="btn" onClick={() => run('updateRoom', { name: roomName })}>Save</button>
            </div>
          </label>

          {room.mode !== 'name' && (
            <label className="field">
              <span>Roles (comma separated)</span>
              <div className="row-input">
                <input value={rolesText} onChange={(e) => setRolesText(e.target.value)} />
                <button className="btn" onClick={() => run('updateRoom', { roles: rolesText.split(',') })}>Save</button>
              </div>
            </label>
          )}

          <div className="field">
            <span>Expiry — {room.permanent ? 'Permanent' : expiryText(room.expiresAt)}</span>
            <div className="btn-row">
              {!room.permanent && <button className="btn" onClick={() => run('updateRoom', { extendHours: 12 })}>+12h</button>}
              {!room.permanent && <button className="btn" onClick={() => run('updateRoom', { extendHours: 24 })}>+24h</button>}
              <button className="btn" onClick={() => run('updateRoom', { permanent: !room.permanent })}>
                {room.permanent ? 'Make expiring' : 'Make permanent'}
              </button>
            </div>
          </div>

          <div className="field">
            <span>Custom groups</span>
            <ul className="mini-list">
              {room.groups.map((g) => (
                <li key={g.id}>
                  <span>{g.name} <small className="muted">({g.members.length})</small></span>
                  <button className="btn ghost small" onClick={() => onEditGroup(g)}>Edit</button>
                </li>
              ))}
            </ul>
            <button className="btn" onClick={() => onEditGroup('new')}>+ New group</button>
          </div>

          <div className="btn-row">
            <button className="btn" onClick={() => confirm('Old invite links will stop working. Continue?') && run('rotateLink')}>
              New invite link
            </button>
            {!confirmEnd ? (
              <button className="btn danger" onClick={() => setConfirmEnd(true)}>End room…</button>
            ) : (
              <button className="btn danger solid" onClick={() => run('endRoom')}>Confirm: end for everyone</button>
            )}
          </div>
        </section>
      )}
      {err && <p className="error">{err}</p>}
    </Sheet>
  );
}

// ------------------------------------------------------------------ person (admin)

export function PersonSheet({ ic, room, slot, onClose, onEditRouting }: {
  ic: Intercom; room: RoomView; slot: SlotView; onClose: () => void; onEditRouting: () => void;
}) {
  const { err, run } = useAction(ic);
  const [name, setName] = useState(slot.name ?? '');
  const [role, setRole] = useState(slot.role ?? '');
  const isUser = slot.kind === 'user';
  return (
    <Sheet title={slotLabel(slot)} onClose={onClose}>
      <section className="panel">
        {(room.mode !== 'role' || !isUser) && (
          <label className="field">
            <span>Name</span>
            <input value={name} maxLength={40} onChange={(e) => setName(e.target.value)} />
          </label>
        )}
        {room.mode !== 'name' && isUser && (
          <label className="field">
            <span>Role</span>
            <select value={role} onChange={(e) => setRole(e.target.value)}>
              {room.roles.map((r) => <option key={r}>{r}</option>)}
            </select>
          </label>
        )}
        <div className="btn-row">
          <button className="btn" onClick={() => run('updateSlot', { slotId: slot.id, name, role })}>Save</button>
        </div>
      </section>
      {isUser && (
        <section className="panel">
          <div className="btn-row wrap">
            <button className="btn" onClick={() => { onEditRouting(); onClose(); }}>Edit their routing</button>
            <button className={cx('btn', slot.locked && 'on')} onClick={() => run('setLocked', { slotId: slot.id, locked: !slot.locked })}>
              {slot.locked ? 'Unlock routing' : 'Lock routing'}
            </button>
            <button className={cx('btn', slot.isAdmin && 'on')} onClick={() => run('setAdmin', { slotId: slot.id, isAdmin: !slot.isAdmin })}>
              {slot.isAdmin ? 'Remove admin' : 'Make admin'}
            </button>
          </div>
        </section>
      )}
      <section className="panel">
        <button className="btn danger" onClick={() => confirm(`Remove ${slotLabel(slot)} from the room?`) && run('kick', { slotId: slot.id }).then((ok) => ok && onClose())}>
          Remove from room
        </button>
      </section>
      {err && <p className="error">{err}</p>}
    </Sheet>
  );
}

// ------------------------------------------------------------------ group editor

export function GroupSheet({ ic, room, group, onClose }: { ic: Intercom; room: RoomView; group: GroupView | 'new'; onClose: () => void }) {
  const { err, run } = useAction(ic);
  const isNew = group === 'new';
  const [name, setName] = useState(isNew ? '' : group.name);
  const [members, setMembers] = useState<string[]>(isNew ? [] : group.members);
  const users = room.slots.filter((s) => s.kind === 'user');
  const toggle = (id: string) => setMembers((m) => (m.includes(id) ? m.filter((x) => x !== id) : [...m, id]));
  return (
    <Sheet title={isNew ? 'New group' : 'Edit group'} onClose={onClose}>
      <section className="panel">
        <label className="field">
          <span>Group name</span>
          <input value={name} maxLength={40} autoFocus onChange={(e) => setName(e.target.value)} />
        </label>
        <div className="field">
          <span>Members</span>
          <ul className="mini-list">
            {users.map((s) => (
              <li key={s.id}>
                <label className="check">
                  <input type="checkbox" checked={members.includes(s.id)} onChange={() => toggle(s.id)} />
                  <span>{slotLabel(s)}</span>
                </label>
              </li>
            ))}
          </ul>
        </div>
        <div className="btn-row">
          <button className="btn primary" disabled={!name.trim()}
            onClick={() => run('saveGroup', { id: isNew ? undefined : group.id, name, members }).then((ok) => ok && onClose())}>
            Save
          </button>
          {!isNew && (
            <button className="btn danger" onClick={() => run('deleteGroup', { id: group.id }).then((ok) => ok && onClose())}>Delete</button>
          )}
        </div>
        {err && <p className="error">{err}</p>}
      </section>
    </Sheet>
  );
}
