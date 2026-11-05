import { useEffect, useState } from 'react';
import type { RoomListItem } from '../../../shared/protocol.ts';
import { api } from '../api.ts';
import { navigate } from '../router.ts';
import { expiryText } from '../util.ts';

export function useSession() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  useEffect(() => {
    api<{ authed: boolean }>('GET', '/api/session').then((r) => setAuthed(r.authed), () => setAuthed(false));
  }, []);
  return [authed, setAuthed] as const;
}

export function Login({ onDone, note }: { onDone: () => void; note?: string }) {
  const [pw, setPw] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr('');
    try {
      await api('POST', '/api/login', { password: pw });
      onDone();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="page center">
      <form className="card narrow" onSubmit={submit}>
        <Brand />
        {note && <p className="muted">{note}</p>}
        <label className="field">
          <span>Site password</span>
          <input type="password" autoFocus autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)} />
        </label>
        {err && <p className="error">{err}</p>}
        <button className="btn primary block" disabled={busy || !pw}>Enter</button>
      </form>
    </div>
  );
}

export function Brand() {
  return (
    <div className="brand">
      <img src="/icon.svg" alt="" width={36} height={36} />
      <span>BR Comms</span>
    </div>
  );
}

export function Home() {
  const [authed, setAuthed] = useSession();
  const [rooms, setRooms] = useState<RoomListItem[] | null>(null);

  useEffect(() => {
    if (!authed) return;
    const load = () => api<RoomListItem[]>('GET', '/api/rooms').then(setRooms, () => {});
    load();
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, [authed]);

  if (authed === null) return <div className="page center muted">Loading…</div>;
  if (!authed) return <Login onDone={() => setAuthed(true)} />;

  return (
    <div className="page">
      <header className="topbar">
        <Brand />
        <button className="btn ghost small" onClick={() => api('POST', '/api/logout').then(() => setAuthed(false))}>
          Log out
        </button>
      </header>
      <main className="content">
        <button className="btn primary block big" onClick={() => navigate('/new')}>+ Create room</button>
        <h2 className="section-title">Rooms</h2>
        {rooms === null && <p className="muted">Loading…</p>}
        {rooms?.length === 0 && <p className="muted">No rooms yet.</p>}
        <ul className="room-list">
          {rooms?.map((r) => (
            <li key={r.id}>
              <button className="room-item" onClick={() => navigate(`/r/${r.id}?t=${encodeURIComponent(r.joinToken)}`)}>
                <div>
                  <div className="room-name">{r.name}</div>
                  <div className="muted small">
                    {r.online} online · {r.total} slots · {r.permanent ? 'Permanent' : expiryText(r.expiresAt)}
                  </div>
                </div>
                <span className="chev">›</span>
              </button>
            </li>
          ))}
        </ul>
      </main>
    </div>
  );
}
