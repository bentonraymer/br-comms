import { useCallback, useEffect, useState } from 'react';
import type { RoomPublicInfo, SlotKind } from '../../../shared/protocol.ts';
import { api, ApiError, getSlotToken, setSlotToken } from '../api.ts';
import { unlockAudio } from '../client/mixer.ts';
import { navigate } from '../router.ts';
import { cx } from '../util.ts';
import { Brand, Login } from './Home.tsx';
import { Room } from './Room.tsx';

type Phase =
  | { k: 'checking' }
  | { k: 'login'; note: string }
  | { k: 'error'; msg: string }
  | { k: 'join'; info: RoomPublicInfo }
  | { k: 'room'; token: string; kind: SlotKind };

export function RoomEntry({ roomId, joinToken }: { roomId: string; joinToken: string | null }) {
  const [phase, setPhase] = useState<Phase>({ k: 'checking' });

  const loadInfo = useCallback(async () => {
    try {
      const q = joinToken ? `?t=${encodeURIComponent(joinToken)}` : '';
      const info = await api<RoomPublicInfo>('GET', `/api/rooms/${roomId}${q}`);
      // Keep a working link in the address bar (handy for sharing / reloads).
      if (!joinToken) navigate(`/r/${roomId}?t=${encodeURIComponent(info.joinToken)}`, true);
      setPhase({ k: 'join', info });
    } catch (e) {
      const err = e as ApiError;
      if (err.status === 401) setPhase({ k: 'login', note: 'This link is no longer valid. Enter the site password or ask for a new link.' });
      else setPhase({ k: 'error', msg: err.message });
    }
  }, [roomId, joinToken]);

  useEffect(() => {
    const token = getSlotToken(roomId);
    if (!token) {
      void loadInfo();
      return;
    }
    api<{ slotId: string; kind: SlotKind }>('GET', `/api/rooms/${roomId}/me`, undefined, { 'x-slot-token': token })
      .then((r) => setPhase({ k: 'room', token, kind: r.kind }))
      .catch((e: ApiError) => {
        if (e.status === 404) setSlotToken(roomId, null);
        void loadInfo();
      });
  }, [roomId, loadInfo]);

  switch (phase.k) {
    case 'checking':
      return <div className="page center muted">Connecting…</div>;
    case 'login':
      return <Login note={phase.note} onDone={() => void loadInfo()} />;
    case 'error':
      return (
        <div className="page center">
          <div className="card narrow">
            <Brand />
            <p className="error">{phase.msg}</p>
            <button className="btn block" onClick={() => navigate('/')}>Home</button>
          </div>
        </div>
      );
    case 'join':
      return (
        <JoinForm
          info={phase.info}
          joinToken={joinToken ?? phase.info.joinToken}
          onJoined={(token, kind) => {
            setSlotToken(roomId, token);
            setPhase({ k: 'room', token, kind });
          }}
          refresh={loadInfo}
        />
      );
    case 'room':
      return (
        <Room
          key={phase.token}
          roomId={roomId}
          token={phase.token}
          kind={phase.kind}
          onExit={(clear) => {
            if (clear) setSlotToken(roomId, null);
            void loadInfo();
          }}
        />
      );
  }
}

function JoinForm({ info, joinToken, onJoined, refresh }: {
  info: RoomPublicInfo; joinToken: string; onJoined: (token: string, kind: SlotKind) => void; refresh: () => void;
}) {
  const [name, setName] = useState('');
  const [role, setRole] = useState('');
  const [program, setProgram] = useState(false);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const usesName = info.mode !== 'role' || program;
  const usesRole = info.mode !== 'name' && !program;
  const offline = info.slots.filter((s) => !s.online);

  const join = async (e: React.FormEvent) => {
    e.preventDefault();
    unlockAudio();
    setBusy(true);
    setErr('');
    try {
      const r = await api<{ slotToken: string }>('POST', `/api/rooms/${info.id}/join`, {
        t: joinToken, name, role, kind: program ? 'program' : 'user',
      });
      onJoined(r.slotToken, program ? 'program' : 'user');
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  };

  const reclaim = async (slotId: string, kind: SlotKind) => {
    unlockAudio();
    setErr('');
    try {
      const r = await api<{ slotToken: string }>('POST', `/api/rooms/${info.id}/reclaim`, { t: joinToken, slotId });
      onJoined(r.slotToken, kind);
    } catch (e) {
      setErr((e as Error).message);
      refresh();
    }
  };

  return (
    <div className="page">
      <header className="topbar">
        <Brand />
      </header>
      <main className="content">
        <h1 className="room-title">{info.name}</h1>
        <form className="form" onSubmit={join}>
          {usesName && (
            <label className="field">
              <span>{program ? 'Feed label' : 'Your name'}</span>
              <input value={name} maxLength={40} placeholder={program ? 'Program' : ''} onChange={(e) => setName(e.target.value)} />
            </label>
          )}
          {usesRole && (
            <div className="field">
              <span>Your role</span>
              <div className="role-grid">
                {info.roles.map((r) => (
                  <button type="button" key={r} className={cx('role-btn', role === r && 'on')} onClick={() => setRole(r)}>
                    {r}
                  </button>
                ))}
              </div>
            </div>
          )}
          {err && <p className="error">{err}</p>}
          <button className="btn primary block big" disabled={busy || (usesName && !program && !name.trim()) || (usesRole && !role)}>
            {program ? 'Start program feed' : 'Join'}
          </button>
          <label className="check small">
            <input type="checkbox" checked={program} onChange={(e) => setProgram(e.target.checked)} />
            <span>This device is a program audio source (listen-only feed)</span>
          </label>
        </form>

        {offline.length > 0 && (
          <>
            <h2 className="section-title">Rejoin as</h2>
            <p className="muted small">Lost connection or switched devices? Tap your name to take your slot back.</p>
            <ul className="room-list">
              {offline.map((s) => (
                <li key={s.id}>
                  <button className="room-item" onClick={() => reclaim(s.id, s.kind)}>
                    <span>
                      <span className="dot off" /> {s.label}
                      {s.kind === 'program' && <span className="tag">PGM</span>}
                    </span>
                    <span className="chev">›</span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </main>
    </div>
  );
}
