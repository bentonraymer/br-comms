// Types shared between server and browser client.

export type JoinMode = 'name' | 'role' | 'both';
export type SlotKind = 'user' | 'program';

/**
 * Routing targets are strings:
 *   slot:<id>    a single person
 *   role:<name>  everyone with that role (auto group)
 *   group:<id>   a custom admin-defined group
 *   all          everyone in the room
 */
export type Target = string;

export interface Routing {
  /** Targets this person talks to when PTT/Latch is active. */
  talk: Target[];
  /** Explicit listen overrides. Absent = default (users on, program feeds off). */
  listen: Record<Target, boolean>;
}

export interface TxState {
  /** PTT held or Latch engaged: talk to the routing.talk targets. */
  general: boolean;
  /** Direct talk (row hold / reply): overrides general targets while held. */
  direct: Target | null;
}

export interface SlotView {
  id: string;
  name: string | null;
  role: string | null;
  kind: SlotKind;
  isAdmin: boolean;
  locked: boolean;
  online: boolean;
  routing: Routing;
}

export interface GroupView {
  id: string;
  name: string;
  members: string[];
}

export interface RoomView {
  id: string;
  name: string;
  mode: JoinMode;
  roles: string[];
  permanent: boolean;
  expiresAt: number;
  joinToken: string;
  /** Only sent to admins. */
  adminPin?: string;
  groups: GroupView[];
  slots: SlotView[];
}

export interface Flows {
  /** Slot ids currently talking to me. */
  incoming: string[];
  /** Slot ids I am currently reaching. */
  outgoing: string[];
  /** Last slot that talked to me (for Reply). */
  lastTalker: string | null;
}

export interface Stat {
  rtt: number | null;
  loss: number | null;
}

/** Public info shown on the join screen. */
export interface RoomPublicInfo {
  id: string;
  name: string;
  mode: JoinMode;
  roles: string[];
  joinToken: string;
  slots: { id: string; label: string; online: boolean; kind: SlotKind }[];
}

export interface RoomListItem {
  id: string;
  name: string;
  permanent: boolean;
  expiresAt: number;
  joinToken: string;
  online: number;
  total: number;
}

// ---- WebSocket envelope ----
export interface WsRequest {
  id: number;
  type: string;
  data?: unknown;
}
export interface WsResponse {
  id: number;
  ok: boolean;
  data?: unknown;
  error?: string;
}
export interface WsNotify {
  type: string;
  data?: unknown;
}

/** WebSocket close codes used by the server. */
export const Close = {
  BadToken: 4001,
  Kicked: 4002,
  RoomClosed: 4003,
  Replaced: 4004,
} as const;

export function slotLabel(s: { name: string | null; role: string | null }): string {
  if (s.name && s.role) return `${s.name} · ${s.role}`;
  return s.name || s.role || 'Unnamed';
}

export const LIMITS = {
  name: 40,
  role: 40,
  roomName: 60,
  roles: 40,
  groups: 30,
  slots: 60,
};
