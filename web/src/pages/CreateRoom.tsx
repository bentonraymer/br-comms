import { useState } from 'react';
import type { JoinMode } from '../../../shared/protocol.ts';
import { api, setSlotToken } from '../api.ts';
import { unlockAudio } from '../client/mixer.ts';
import { navigate } from '../router.ts';
import { cx } from '../util.ts';
import { Login, useSession } from './Home.tsx';

export function CreateRoom() {
  const [authed, setAuthed] = useSession();
  const [name, setName] = useState('');
  const [mode, setMode] = useState<JoinMode>('name');
  const [roles, setRoles] = useState<string[]>(['Director', 'Producer', 'Camera', 'Audio', 'Graphics', 'Stage Manager']);
  const [newRole, setNewRole] = useState('');
  const [permanent, setPermanent] = useState(false);
  const [myName, setMyName] = useState('');
  const [myRole, setMyRole] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  if (authed === null) return <div className="page center muted">Loading…</div>;
  if (!authed) return <Login onDone={() => setAuthed(true)} />;

  const usesRole = mode !== 'name';
  const usesName = mode !== 'role';
  const addRole = () => {
    const r = newRole.trim();
    if (r && !roles.includes(r)) setRoles([...roles, r]);
    setNewRole('');
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    unlockAudio();
    setBusy(true);
    setErr('');
    try {
      const res = await api<{ roomId: string; joinToken: string; slotToken: string }>('POST', '/api/rooms', {
        name, mode, roles, permanent, creatorName: myName, creatorRole: myRole,
      });
      setSlotToken(res.roomId, res.slotToken);
      navigate(`/r/${res.roomId}?t=${encodeURIComponent(res.joinToken)}`, true);
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="page">
      <header className="topbar">
        <button className="btn ghost small" onClick={() => navigate('/')}>‹ Back</button>
        <h1 className="title">New room</h1>
        <span />
      </header>
      <form className="content form" onSubmit={submit}>
        <label className="field">
          <span>Room name</span>
          <input value={name} placeholder="e.g. Sunday Service" maxLength={60} onChange={(e) => setName(e.target.value)} />
        </label>

        <div className="field">
          <span>New members enter</span>
          <div className="segmented">
            {(['name', 'role', 'both'] as const).map((m) => (
              <button type="button" key={m} className={cx(mode === m && 'on')} onClick={() => setMode(m)}>
                {m === 'name' ? 'Name' : m === 'role' ? 'Role' : 'Both'}
              </button>
            ))}
          </div>
        </div>

        {usesRole && (
          <div className="field">
            <span>Roles</span>
            <div className="chips">
              {roles.map((r) => (
                <span className="chip" key={r}>
                  {r}
                  <button type="button" aria-label={`Remove ${r}`} onClick={() => setRoles(roles.filter((x) => x !== r))}>×</button>
                </span>
              ))}
            </div>
            <div className="row-input">
              <input
                value={newRole}
                placeholder="Add role"
                maxLength={40}
                onChange={(e) => setNewRole(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    addRole();
                  }
                }}
              />
              <button type="button" className="btn" onClick={addRole}>Add</button>
            </div>
            <p className="muted small">Each role automatically becomes a talk/listen group.</p>
          </div>
        )}

        <label className="check">
          <input type="checkbox" checked={permanent} onChange={(e) => setPermanent(e.target.checked)} />
          <span>
            Permanent room
            <small className="muted"> — never expires (otherwise 24h)</small>
          </span>
        </label>

        <h2 className="section-title">You</h2>
        {usesName && (
          <label className="field">
            <span>Your name</span>
            <input value={myName} maxLength={40} onChange={(e) => setMyName(e.target.value)} />
          </label>
        )}
        {usesRole && (
          <label className="field">
            <span>Your role</span>
            <select value={myRole} onChange={(e) => setMyRole(e.target.value)}>
              <option value="">Select…</option>
              {roles.map((r) => <option key={r}>{r}</option>)}
            </select>
          </label>
        )}

        {err && <p className="error">{err}</p>}
        <button
          className="btn primary block big"
          disabled={busy || (usesName && !myName.trim()) || (usesRole && (!myRole || roles.length === 0))}
        >
          Create & join
        </button>
      </form>
    </div>
  );
}
