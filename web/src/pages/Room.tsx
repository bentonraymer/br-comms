import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { slotLabel, type GroupView, type Routing, type SlotKind, type SlotView, type Target } from '../../../shared/protocol.ts';
import {
  ALL, containingTargets, groupTarget, listensTo, roleTarget, slotTarget, type RoutingContext, type RoutingSlot,
} from '../../../shared/routing.ts';
import { pref } from '../api.ts';
import { Intercom, type EndReason } from '../client/intercom.ts';
import { ProgramView } from '../components/Program.tsx';
import { Quality, TargetRow, useHold } from '../components/Rows.tsx';
import { GroupSheet, MenuSheet, PersonSheet } from '../components/Sheets.tsx';
import { cx, expiryText } from '../util.ts';

function useIntercom(roomId: string, token: string, kind: SlotKind) {
  const ic = useMemo(() => new Intercom(roomId, token, kind, pref('audioMode', 'webaudio')), [roomId, token, kind]);
  const state = useSyncExternalStore(
    useCallback((cb) => {
      const unsub = ic.subscribe(cb);
      return () => void unsub();
    }, [ic]),
    () => ic.state,
  );
  useEffect(() => () => ic.stop(), [ic]);
  return [ic, state] as const;
}

const END_TEXT: Record<EndReason, string> = {
  kicked: 'You were removed from the room.',
  closed: 'This room has ended.',
  replaced: 'You opened this room on another device or tab.',
  invalid: 'Your slot is no longer valid.',
  left: 'You left the room.',
};

export function Room({ roomId, token, kind, onExit }: { roomId: string; token: string; kind: SlotKind; onExit: (clear: boolean) => void }) {
  const [ic, s] = useIntercom(roomId, token, kind);
  const [started, setStarted] = useState(false);

  const start = useCallback(() => {
    setStarted(true);
    void ic.start();
  }, [ic]);

  // If audio was already unlocked by the join tap, connect immediately.
  useEffect(() => {
    if (ic.mixer.running) start();
  }, [ic, start]);

  if (s.conn === 'ended') {
    const reason = s.endReason ?? 'closed';
    return (
      <div className="page center">
        <div className="card narrow">
          <p>{END_TEXT[reason]}</p>
          {reason === 'replaced' ? (
            <button className="btn primary block" onClick={() => location.reload()}>Use this device instead</button>
          ) : (
            <button className="btn primary block" onClick={() => onExit(true)}>Continue</button>
          )}
        </div>
      </div>
    );
  }

  if (!started) {
    return (
      <div className="page center">
        <div className="card narrow">
          <h2>Ready to connect</h2>
          <ul className="tips">
            <li>Use a headset to avoid echo.</li>
            <li>Keep this screen open — locking your phone may cut audio.</li>
          </ul>
          <button className="btn primary block big" onClick={start}>Tap to connect audio</button>
        </div>
      </div>
    );
  }

  if (kind === 'program') return <ProgramView ic={ic} s={s} />;
  return <CrewView ic={ic} />;
}

/** Main crew intercom screen. */
function CrewView({ ic }: { ic: Intercom }) {
  const s = useSyncExternalStore(
    useCallback((cb) => {
      const u = ic.subscribe(cb);
      return () => void u();
    }, [ic]),
    () => ic.state,
  );
  const room = s.room;
  const me = room?.slots.find((x) => x.id === s.me) ?? null;

  const [pttHeld, setPttHeld] = useState(false);
  const [latched, setLatched] = useState(false);
  const [direct, setDirect] = useState<Target | null>(null);
  const [menu, setMenu] = useState(false);
  const [person, setPerson] = useState<string | null>(null);
  const [groupEdit, setGroupEdit] = useState<GroupView | 'new' | null>(null);
  const [editing, setEditing] = useState<string | null>(null); // admin editing someone else's routing
  const [toast, setToast] = useState('');
  const [, bump] = useState(0);
  const [, tick] = useState(0);

  useEffect(() => {
    const t = setInterval(() => tick((x) => x + 1), 30_000);
    return () => clearInterval(t);
  }, []);

  // Push transmit state to the engine.
  useEffect(() => {
    ic.setTx({ general: pttHeld || latched, direct });
  }, [ic, pttHeld, latched, direct]);

  // Spacebar = PTT on desktop.
  useEffect(() => {
    const isField = (e: KeyboardEvent) => (e.target as HTMLElement)?.closest('input, textarea, select');
    const down = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !e.repeat && !isField(e)) {
        e.preventDefault();
        setPttHeld(true);
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !isField(e)) {
        e.preventDefault();
        setPttHeld(false);
      }
    };
    const blur = () => setPttHeld(false);
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
    };
  }, []);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(''), 2500);
    return () => clearTimeout(t);
  }, [toast]);

  if (!room || !me) {
    return (
      <div className="page center muted">
        {s.micError ? <p className="error">{s.micError}</p> : s.conn === 'reconnecting' ? 'Reconnecting…' : 'Connecting…'}
      </div>
    );
  }

  const subject = (editing && room.slots.find((x) => x.id === editing)) || me;
  const editingOther = subject.id !== me.id;
  const routing = subject.routing;
  const canEdit = me.isAdmin || !subject.locked;

  const ctx: RoutingContext = {
    slots: room.slots.map((x) => ({ id: x.id, kind: x.kind, role: x.role, online: x.online, routing: x.routing, tx: { general: false, direct: null } })),
    groups: room.groups,
  };
  const subjectRS = ctx.slots.find((x) => x.id === subject.id)!;
  const rsOf = (id: string) => ctx.slots.find((x) => x.id === id) as RoutingSlot;

  const save = (r: Routing) => {
    ic.setRouting(r, editingOther ? subject.id : undefined).catch((e: Error) => setToast(e.message));
  };
  const toggleTalk = (t: Target) => {
    if (!canEdit) return setToast('Routing is locked by an admin');
    const on = routing.talk.includes(t);
    save({ ...routing, talk: on ? routing.talk.filter((x) => x !== t) : [...routing.talk, t] });
  };
  const setListen = (t: Target, v: boolean, clearMembers?: string[]) => {
    if (!canEdit) return setToast('Routing is locked by an admin');
    const listen = { ...routing.listen, [t]: v };
    for (const id of clearMembers ?? []) delete listen[slotTarget(id)];
    save({ ...routing, listen });
  };

  const incoming = new Set(s.flows.incoming);
  const outgoing = new Set(s.flows.outgoing);
  const transmitting = pttHeld || latched || !!direct;
  const lastTalker = s.flows.lastTalker ? room.slots.find((x) => x.id === s.flows.lastTalker) : null;

  const users = room.slots.filter((x) => x.kind === 'user' && x.id !== subject.id);
  const programs = room.slots.filter((x) => x.kind === 'program');
  // Only show role groups that have people in them (or that this routing already targets).
  const roleGroups = room.mode !== 'name'
    ? room.roles.filter((r) => room.slots.some((x) => x.kind === 'user' && x.role === r) || routing.talk.includes(roleTarget(r)))
    : [];

  const groupRow = (target: Target, label: string, members: string[], key: string) => {
    const talkOn = routing.talk.includes(target);
    const listenVal = routing.listen[target] ?? true;
    const activeOut = direct === target || ((pttHeld || latched) && talkOn);
    return (
      <TargetRow
        key={key}
        label={label}
        sub={`${members.length} ${members.length === 1 ? 'person' : 'people'} · hold to talk`}
        talk={talkOn ? 'on' : 'off'}
        listen={listenVal}
        disabled={!canEdit}
        outgoing={activeOut && !editingOther}
        directActive={direct === target}
        onTalk={() => toggleTalk(target)}
        onListen={() => setListen(target, !listenVal, members)}
        onHoldStart={() => setDirect(target)}
        onHoldEnd={() => setDirect((d) => (d === target ? null : d))}
      />
    );
  };

  const membersOf = (pred: (x: SlotView) => boolean) => room.slots.filter((x) => x.kind === 'user' && pred(x)).map((x) => x.id);

  const personRow = (x: SlotView) => {
    const t = slotTarget(x.id);
    const rs = rsOf(x.id);
    const explicit = routing.talk.includes(t);
    const via = !explicit && containingTargets(rs, ctx).some((g) => routing.talk.includes(g));
    const listen = listensTo(subjectRS, rs, ctx);
    const isProgram = x.kind === 'program';
    return (
      <TargetRow
        key={x.id}
        label={slotLabel(x)}
        sub={isProgram ? 'Program feed' : x.isAdmin ? 'Admin · hold to talk' : 'Hold to talk'}
        tag={isProgram ? 'PGM' : x.isAdmin ? 'ADMIN' : undefined}
        online={x.online}
        stat={s.stats[x.id]}
        incoming={!editingOther && incoming.has(x.id)}
        outgoing={!editingOther && outgoing.has(x.id)}
        talk={isProgram ? null : explicit ? 'on' : via ? 'via' : 'off'}
        listen={listen}
        disabled={!canEdit}
        directActive={direct === t}
        volume={ic.mixer.volume(x.id)}
        onVolume={editingOther ? undefined : (v) => {
          ic.mixer.setVolume(x.id, v);
          bump((n) => n + 1);
        }}
        onTalk={() => {
          if (via) return setToast('Talking via a group — turn that group off to stop');
          toggleTalk(t);
        }}
        onListen={() => setListen(t, !listen)}
        onHoldStart={isProgram ? undefined : () => setDirect(t)}
        onHoldEnd={isProgram ? undefined : () => setDirect((d) => (d === t ? null : d))}
        onMore={me.isAdmin ? () => setPerson(x.id) : undefined}
      />
    );
  };

  const personSlot = person ? room.slots.find((x) => x.id === person) : null;

  return (
    <div className="page room" onPointerDown={() => ic.poke()}>
      <header className="topbar room-top">
        <div className="room-head">
          <div className="room-name-line">
            <span className={cx('dot', s.conn === 'connected' ? 'on' : 'warn')} />
            <span className="title">{room.name}</span>
          </div>
          <div className="muted small">
            {slotLabel(me)} {me.isAdmin && <span className="tag">ADMIN</span>} <Quality stat={s.stats[me.id]} /> ·{' '}
            {room.permanent ? 'Permanent' : expiryText(room.expiresAt)}
          </div>
        </div>
        <button className="btn ghost" aria-label="Menu" onClick={() => setMenu(true)}>☰</button>
      </header>

      {(s.conn !== 'connected' || s.micError || s.mediaError || !s.audioRunning) && (
        <div className="banner warn" onClick={() => ic.poke()}>
          {s.micError ?? s.mediaError ?? (s.conn !== 'connected' ? 'Reconnecting…' : 'Audio paused — tap anywhere to resume')}
        </div>
      )}
      {editingOther && (
        <div className="banner info">
          Editing routing for <b>{slotLabel(subject)}</b>
          <button className="btn small" onClick={() => setEditing(null)}>Done</button>
        </div>
      )}
      {!editingOther && me.locked && <div className="banner">Your routing is locked by an admin</div>}

      <main className="content list">
        <h2 className="section-title">Groups</h2>
        <ul className="rows">
          {groupRow(ALL, 'Everyone', membersOf((x) => x.id !== subject.id), 'all')}
          {roleGroups.map((r) => groupRow(roleTarget(r), r, membersOf((x) => x.role === r && x.id !== subject.id), `role-${r}`))}
          {room.groups.map((g) => groupRow(groupTarget(g.id), g.name, g.members.filter((m) => m !== subject.id), g.id))}
        </ul>

        <h2 className="section-title">People</h2>
        {users.length === 0 && <p className="muted small">Nobody else yet — share the invite from the menu.</p>}
        <ul className="rows">{users.map(personRow)}</ul>

        {programs.length > 0 && (
          <>
            <h2 className="section-title">Program</h2>
            <ul className="rows">{programs.map(personRow)}</ul>
          </>
        )}
      </main>

      <PttBar
        transmitting={transmitting}
        pttHeld={pttHeld}
        latched={latched}
        lastTalker={lastTalker ? slotLabel(lastTalker) : null}
        replying={!!lastTalker && direct === slotTarget(lastTalker.id)}
        onPtt={setPttHeld}
        onLatch={() => setLatched((l) => !l)}
        onReply={(on) => {
          if (!lastTalker) return;
          const t = slotTarget(lastTalker.id);
          setDirect((d) => (on ? t : d === t ? null : d));
        }}
      />

      {toast && <div className="toast">{toast}</div>}
      {menu && <MenuSheet ic={ic} room={room} me={me} onClose={() => setMenu(false)} onEditGroup={(g) => { setMenu(false); setGroupEdit(g); }} />}
      {personSlot && (
        <PersonSheet ic={ic} room={room} slot={personSlot} onClose={() => setPerson(null)} onEditRouting={() => setEditing(personSlot.id)} />
      )}
      {groupEdit && <GroupSheet ic={ic} room={room} group={groupEdit} onClose={() => setGroupEdit(null)} />}
    </div>
  );
}

function PttBar(p: {
  transmitting: boolean; pttHeld: boolean; latched: boolean; lastTalker: string | null; replying: boolean;
  onPtt: (on: boolean) => void; onLatch: () => void; onReply: (on: boolean) => void;
}) {
  const reply = useHold(() => p.onReply(true), () => p.onReply(false), 0);
  const ptt = useHold(() => p.onPtt(true), () => p.onPtt(false), 0);
  return (
    <footer className={cx('ptt-bar', p.transmitting && 'live')}>
      <button className={cx('ptt-side reply', p.replying && 'on')} disabled={!p.lastTalker} {...reply}>
        <span className="k">Reply</span>
        <span className="v">{p.lastTalker ?? '—'}</span>
      </button>
      <button className={cx('ptt-main', p.pttHeld && 'on')} {...ptt}>
        {p.transmitting ? 'TALKING' : 'PUSH TO TALK'}
      </button>
      <button className={cx('ptt-side latch', p.latched && 'on')} onClick={p.onLatch}>
        <span className="k">Latch</span>
        <span className="v">{p.latched ? 'ON' : 'off'}</span>
      </button>
    </footer>
  );
}
