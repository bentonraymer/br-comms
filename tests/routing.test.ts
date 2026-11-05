import { describe, expect, it } from 'vitest';
import type { GroupView, Routing, TxState } from '../shared/protocol.ts';
import { computeFlows, listensTo, sanitizeRouting, type RoutingContext, type RoutingSlot } from '../shared/routing.ts';

const idle: TxState = { general: false, direct: null };
function slot(id: string, o: Partial<RoutingSlot> & { talk?: string[]; listen?: Routing['listen'] } = {}): RoutingSlot {
  return {
    id, kind: o.kind ?? 'user', role: o.role ?? null, online: o.online ?? true,
    routing: { talk: o.talk ?? [], listen: o.listen ?? {} }, tx: o.tx ?? idle,
  };
}
const ctx = (slots: RoutingSlot[], groups: GroupView[] = []): RoutingContext => ({ slots, groups });
const flows = (c: RoutingContext) => [...computeFlows(c)].sort();

describe('computeFlows', () => {
  it('no flows when nobody transmits', () => {
    expect(flows(ctx([slot('a', { talk: ['all'] }), slot('b')]))).toEqual([]);
  });

  it('PTT to everyone reaches all other online users', () => {
    const c = ctx([slot('a', { talk: ['all'], tx: { general: true, direct: null } }), slot('b'), slot('c'), slot('d', { online: false })]);
    expect(flows(c)).toEqual(['a>b', 'a>c']);
  });

  it('talks only to toggled people and role groups', () => {
    const c = ctx([
      slot('dir', { talk: ['slot:b', 'role:Camera'], tx: { general: true, direct: null } }),
      slot('b'), slot('c1', { role: 'Camera' }), slot('c2', { role: 'Camera' }), slot('x', { role: 'Audio' }),
    ]);
    expect(flows(c)).toEqual(['dir>b', 'dir>c1', 'dir>c2']);
  });

  it('custom groups resolve to members', () => {
    const g: GroupView = { id: 'g1', name: 'Stage', members: ['b', 'c'] };
    const c = ctx([slot('a', { talk: ['group:g1'], tx: { general: true, direct: null } }), slot('b'), slot('c'), slot('d')], [g]);
    expect(flows(c)).toEqual(['a>b', 'a>c']);
  });

  it('direct (row hold / reply) overrides general targets', () => {
    const c = ctx([slot('a', { talk: ['all'], tx: { general: true, direct: 'slot:c' } }), slot('b'), slot('c')]);
    expect(flows(c)).toEqual(['a>c']);
  });

  it('listener can mute a person', () => {
    const c = ctx([slot('a', { talk: ['all'], tx: { general: true, direct: null } }), slot('b', { listen: { 'slot:a': false } }), slot('c')]);
    expect(flows(c)).toEqual(['a>c']);
  });

  it('per-person listen beats group mute', () => {
    const a = slot('a', { role: 'Camera', talk: ['all'], tx: { general: true, direct: null } });
    const b = slot('b', { listen: { 'role:Camera': false, 'slot:a': true } });
    expect(listensTo(b, a, ctx([a, b]))).toBe(true);
    const b2 = slot('b', { listen: { 'role:Camera': false } });
    expect(listensTo(b2, a, ctx([a, b2]))).toBe(false);
  });

  it('program feeds always transmit but are off by default for listeners', () => {
    const p = slot('p', { kind: 'program' });
    const c = ctx([p, slot('b'), slot('c', { listen: { 'slot:p': true } })]);
    expect(flows(c)).toEqual(['p>c']);
  });

  it('program feeds never receive audio', () => {
    const c = ctx([slot('a', { talk: ['all'], tx: { general: true, direct: null } }), slot('p', { kind: 'program' })]);
    expect(flows(c)).toEqual([]);
  });

  it('no self flow', () => {
    const c = ctx([slot('a', { talk: ['slot:a', 'all'], tx: { general: true, direct: null } })]);
    expect(flows(c)).toEqual([]);
  });
});

describe('sanitizeRouting', () => {
  it('drops junk', () => {
    expect(sanitizeRouting({ talk: ['all', 'slot:x', 'bogus', 5, 'all'], listen: { 'slot:y': false, evil: true, 'role:A': 'yes' } }))
      .toEqual({ talk: ['all', 'slot:x'], listen: { 'slot:y': false } });
    expect(sanitizeRouting(null)).toEqual({ talk: [], listen: {} });
  });
});
