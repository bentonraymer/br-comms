// Pure routing engine: decides which audio flows (A -> B) are active.
import type { GroupView, Routing, SlotKind, Target, TxState } from './protocol.ts';

export interface RoutingSlot {
  id: string;
  kind: SlotKind;
  role: string | null;
  online: boolean;
  routing: Routing;
  tx: TxState;
}

export interface RoutingContext {
  slots: RoutingSlot[];
  groups: GroupView[];
}

export const slotTarget = (id: string): Target => `slot:${id}`;
export const roleTarget = (role: string): Target => `role:${role}`;
export const groupTarget = (id: string): Target => `group:${id}`;
export const ALL: Target = 'all';

/** Members (slot ids) a target refers to. Program feeds are never talk/listen members of groups. */
export function resolveTarget(target: Target, ctx: RoutingContext): Set<string> {
  const out = new Set<string>();
  if (target === ALL) {
    for (const s of ctx.slots) if (s.kind === 'user') out.add(s.id);
  } else if (target.startsWith('slot:')) {
    const id = target.slice(5);
    if (ctx.slots.some((s) => s.id === id)) out.add(id);
  } else if (target.startsWith('role:')) {
    const role = target.slice(5);
    for (const s of ctx.slots) if (s.kind === 'user' && s.role === role) out.add(s.id);
  } else if (target.startsWith('group:')) {
    const g = ctx.groups.find((g) => g.id === target.slice(6));
    if (g) for (const id of g.members) if (ctx.slots.some((s) => s.id === id && s.kind === 'user')) out.add(id);
  }
  return out;
}

/** Group-ish targets (all/role/group) that contain this slot. */
export function containingTargets(slot: RoutingSlot, ctx: RoutingContext): Target[] {
  if (slot.kind !== 'user') return [];
  const out: Target[] = [ALL];
  if (slot.role) out.push(roleTarget(slot.role));
  for (const g of ctx.groups) if (g.members.includes(slot.id)) out.push(groupTarget(g.id));
  return out;
}

/**
 * Does `listener` want to hear `source`?
 * Priority: explicit per-person setting > custom/role group setting > "all" setting > default.
 * Among groups, any explicit "off" wins over an explicit "on".
 */
export function listensTo(listener: RoutingSlot, source: RoutingSlot, ctx: RoutingContext): boolean {
  const l = listener.routing.listen;
  const direct = l[slotTarget(source.id)];
  if (direct !== undefined) return direct;
  const groups = containingTargets(source, ctx).filter((t) => t !== ALL);
  const vals = groups.map((t) => l[t]).filter((v): v is boolean => v !== undefined);
  if (vals.length) return !vals.includes(false);
  if (source.kind === 'user' && l[ALL] !== undefined) return l[ALL];
  return source.kind === 'user';
}

/** Slot ids `slot` is currently transmitting to (before listener filtering). */
export function transmitTargets(slot: RoutingSlot, ctx: RoutingContext): Set<string> {
  if (!slot.online) return new Set();
  if (slot.kind === 'program') return resolveTarget(ALL, ctx);
  if (slot.tx.direct) return resolveTarget(slot.tx.direct, ctx);
  if (!slot.tx.general) return new Set();
  const out = new Set<string>();
  for (const t of slot.routing.talk) for (const id of resolveTarget(t, ctx)) out.add(id);
  return out;
}

export type FlowKey = `${string}>${string}`;
export const flowKey = (from: string, to: string): FlowKey => `${from}>${to}`;

/** All active audio flows in a room. */
export function computeFlows(ctx: RoutingContext): Set<FlowKey> {
  const byId = new Map(ctx.slots.map((s) => [s.id, s]));
  const flows = new Set<FlowKey>();
  for (const a of ctx.slots) {
    for (const bId of transmitTargets(a, ctx)) {
      if (bId === a.id) continue;
      const b = byId.get(bId);
      if (!b || !b.online || b.kind !== 'user') continue;
      if (!listensTo(b, a, ctx)) continue;
      flows.add(flowKey(a.id, b.id));
    }
  }
  return flows;
}

/** Normalize a routing object coming from a client. */
export function sanitizeRouting(r: unknown): Routing {
  const out: Routing = { talk: [], listen: {} };
  if (!r || typeof r !== 'object') return out;
  const obj = r as Record<string, unknown>;
  const valid = (t: unknown): t is string =>
    typeof t === 'string' && t.length < 80 && (t === ALL || /^(slot|role|group):/.test(t));
  if (Array.isArray(obj.talk)) out.talk = [...new Set(obj.talk.filter(valid))].slice(0, 200);
  if (obj.listen && typeof obj.listen === 'object') {
    for (const [k, v] of Object.entries(obj.listen as Record<string, unknown>).slice(0, 200)) {
      if (valid(k) && typeof v === 'boolean') out.listen[k] = v;
    }
  }
  return out;
}
