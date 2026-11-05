// Persistent room/slot/group storage. In-memory model with write-through to SQLite.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { JoinMode, Routing, SlotKind } from '../../shared/protocol.ts';

export interface Room {
  id: string;
  name: string;
  mode: JoinMode;
  roles: string[];
  permanent: boolean;
  expiresAt: number;
  joinToken: string;
  adminPin: string;
  createdAt: number;
}

export interface Slot {
  id: string;
  roomId: string;
  name: string | null;
  role: string | null;
  kind: SlotKind;
  tokenHash: string;
  isAdmin: boolean;
  locked: boolean;
  routing: Routing;
  sort: number;
  createdAt: number;
}

export interface Group {
  id: string;
  roomId: string;
  name: string;
  members: string[];
  sort: number;
}

export class Store {
  private db: DatabaseSync;
  rooms = new Map<string, Room>();
  slots = new Map<string, Slot>();
  groups = new Map<string, Group>();

  constructor(dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(path.join(dataDir, 'br-comms.db'));
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS rooms (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, mode TEXT NOT NULL, roles TEXT NOT NULL,
        permanent INTEGER NOT NULL, expires_at INTEGER NOT NULL, join_token TEXT NOT NULL,
        admin_pin TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS slots (
        id TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        name TEXT, role TEXT, kind TEXT NOT NULL, token_hash TEXT NOT NULL,
        is_admin INTEGER NOT NULL, locked INTEGER NOT NULL, routing TEXT NOT NULL,
        sort INTEGER NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS groups_ (
        id TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        name TEXT NOT NULL, members TEXT NOT NULL, sort INTEGER NOT NULL);
    `);
    this.load();
  }

  private load() {
    for (const r of this.db.prepare('SELECT * FROM rooms').all() as any[]) {
      this.rooms.set(r.id, {
        id: r.id, name: r.name, mode: r.mode, roles: JSON.parse(r.roles), permanent: !!r.permanent,
        expiresAt: r.expires_at, joinToken: r.join_token, adminPin: r.admin_pin, createdAt: r.created_at,
      });
    }
    for (const s of this.db.prepare('SELECT * FROM slots').all() as any[]) {
      this.slots.set(s.id, {
        id: s.id, roomId: s.room_id, name: s.name, role: s.role, kind: s.kind, tokenHash: s.token_hash,
        isAdmin: !!s.is_admin, locked: !!s.locked, routing: JSON.parse(s.routing), sort: s.sort,
        createdAt: s.created_at,
      });
    }
    for (const g of this.db.prepare('SELECT * FROM groups_').all() as any[]) {
      this.groups.set(g.id, { id: g.id, roomId: g.room_id, name: g.name, members: JSON.parse(g.members), sort: g.sort });
    }
  }

  getMeta(key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value;
  }
  setMeta(key: string, value: string) {
    this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  saveRoom(r: Room) {
    this.rooms.set(r.id, r);
    this.db.prepare(`INSERT INTO rooms (id, name, mode, roles, permanent, expires_at, join_token, admin_pin, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, mode = excluded.mode,
      roles = excluded.roles, permanent = excluded.permanent, expires_at = excluded.expires_at,
      join_token = excluded.join_token, admin_pin = excluded.admin_pin`)
      .run(r.id, r.name, r.mode, JSON.stringify(r.roles), r.permanent ? 1 : 0, r.expiresAt, r.joinToken, r.adminPin, r.createdAt);
  }

  deleteRoom(id: string) {
    this.rooms.delete(id);
    for (const [sid, s] of this.slots) if (s.roomId === id) this.slots.delete(sid);
    for (const [gid, g] of this.groups) if (g.roomId === id) this.groups.delete(gid);
    this.db.prepare('DELETE FROM rooms WHERE id = ?').run(id);
  }

  saveSlot(s: Slot) {
    this.slots.set(s.id, s);
    this.db.prepare(`INSERT INTO slots (id, room_id, name, role, kind, token_hash, is_admin, locked, routing, sort, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, role = excluded.role,
      token_hash = excluded.token_hash, is_admin = excluded.is_admin, locked = excluded.locked,
      routing = excluded.routing, sort = excluded.sort`)
      .run(s.id, s.roomId, s.name, s.role, s.kind, s.tokenHash, s.isAdmin ? 1 : 0, s.locked ? 1 : 0,
        JSON.stringify(s.routing), s.sort, s.createdAt);
  }

  deleteSlot(id: string) {
    this.slots.delete(id);
    this.db.prepare('DELETE FROM slots WHERE id = ?').run(id);
  }

  saveGroup(g: Group) {
    this.groups.set(g.id, g);
    this.db.prepare(`INSERT INTO groups_ (id, room_id, name, members, sort) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name = excluded.name, members = excluded.members, sort = excluded.sort`)
      .run(g.id, g.roomId, g.name, JSON.stringify(g.members), g.sort);
  }

  deleteGroup(id: string) {
    this.groups.delete(id);
    this.db.prepare('DELETE FROM groups_ WHERE id = ?').run(id);
  }

  roomSlots(roomId: string): Slot[] {
    return [...this.slots.values()].filter((s) => s.roomId === roomId).sort((a, b) => a.sort - b.sort);
  }

  roomGroups(roomId: string): Group[] {
    return [...this.groups.values()].filter((g) => g.roomId === roomId).sort((a, b) => a.sort - b.sort);
  }

  slotByToken(roomId: string, tokenHash: string): Slot | undefined {
    for (const s of this.slots.values()) if (s.roomId === roomId && s.tokenHash === tokenHash) return s;
    return undefined;
  }
}
