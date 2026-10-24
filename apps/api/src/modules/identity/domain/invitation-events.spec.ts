import { parseId, parseMarketId, Temporal } from '@mondapac-drive/shared-kernel';
import type { Id, MarketId, PendingEvent } from '@mondapac-drive/shared-kernel';
import { parseEmailAddress } from './email-address';
import { Invitation } from './invitation';

// Slice 7b: the events of the Invitation aggregate (identity design 3.4, 8.2) and the rule that
// lets an issue replace a stale pending invitation (M7; item G, Ali 2026-10-08): one past its
// expiry, or one never dispatched (no token) whose creation is older than its kind's lifetime.

const NOW = Temporal.Instant.from('2026-10-08T10:00:00Z');
const HASH = new Uint8Array(32).fill(7);

function id<T extends string>(text: string): Id<T> {
  const parsed = parseId(text);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
}
function market(code: string): MarketId {
  const parsed = parseMarketId(code);
  if (!parsed.ok) throw new Error('bad market');
  return parsed.value;
}
const email = (raw: string) => {
  const parsed = parseEmailAddress(raw);
  if (!parsed.ok) throw new Error('bad email');
  return parsed.value;
};

const INVITATION_ID = id<'Invitation'>('01990000-0000-7000-8000-0000000000c1');
const ROLE_ID = id<'Role'>('01990000-0000-7000-8000-0000000000d1');
const ACCOUNT_ID = id<'Account'>('01990000-0000-7000-8000-000000000001');

const summary = (events: readonly PendingEvent[]) =>
  events.map((event) => ({
    type: event.type,
    aggregateId: event.aggregateId,
    aggregateVersion: event.aggregateVersion,
    payload: event.payload,
  }));

// Each fixture Market has its own admin invitation lifetime: AU 72 hours, ZZ 48 hours.
describe.each([
  ['AU', 4320],
  ['ZZ', 2880],
] as const)('Invitation events and replacement in market %s (slice 7b)', (code, lifetime) => {
  const marketId = market(code);
  const issue = (at: Temporal.Instant = NOW) =>
    Invitation.issue({
      id: INVITATION_ID,
      marketId,
      kind: 'admin',
      email: email('New.Admin@Example.test'),
      roleId: ROLE_ID,
      sellerId: null,
      invitedByAccountId: null,
      now: at,
    });

  it('records `invitation-issued` at issue, with no address or name (8.2)', () => {
    expect(summary(issue().pendingEvents)).toEqual([
      {
        type: 'identity.invitation-issued.v1',
        aggregateId: INVITATION_ID,
        aggregateVersion: 1,
        payload: { invitationId: INVITATION_ID, kind: 'admin', sellerId: null },
      },
    ]);
  });

  it('records `invitation-accepted` with the new account at acceptance; dispatch records none', () => {
    const invitation = Invitation.restore(issue().state);
    expect(invitation.dispatch(HASH, NOW, lifetime).ok).toBe(true);
    expect(invitation.pendingEvents).toEqual([]);
    expect(invitation.accept(ACCOUNT_ID, NOW.add({ minutes: 1 })).ok).toBe(true);
    expect(summary(invitation.pendingEvents)).toEqual([
      {
        type: 'identity.invitation-accepted.v1',
        aggregateId: INVITATION_ID,
        aggregateVersion: 3,
        payload: {
          invitationId: INVITATION_ID,
          kind: 'admin',
          sellerId: null,
          accountId: ACCOUNT_ID,
        },
      },
    ]);
  });

  it('is replaceable when never dispatched and older than its lifetime, not a moment before (G)', () => {
    const invitation = Invitation.restore(issue().state);
    expect(invitation.replaceableAt(NOW.add({ minutes: lifetime - 1 }), lifetime)).toBe(false);
    expect(invitation.replaceableAt(NOW.add({ minutes: lifetime }), lifetime)).toBe(true);
  });

  it('is replaceable once dispatched only after its expiry (M7)', () => {
    const invitation = Invitation.restore(issue().state);
    expect(invitation.dispatch(HASH, NOW.add({ minutes: 10 }), lifetime).ok).toBe(true);
    const restored = Invitation.restore(invitation.state);
    // Older than the lifetime since creation, but its token is still live.
    expect(restored.replaceableAt(NOW.add({ minutes: lifetime }), lifetime)).toBe(false);
    expect(restored.replaceableAt(NOW.add({ minutes: lifetime + 10 }), lifetime)).toBe(true);
  });

  it('is never replaceable once decided', () => {
    const invitation = Invitation.restore(issue().state);
    expect(invitation.revoke(NOW).ok).toBe(true);
    expect(invitation.replaceableAt(NOW.add({ minutes: lifetime * 2 }), lifetime)).toBe(false);
  });

  it('refuses a lifetime that is not a positive whole number of minutes', () => {
    const invitation = Invitation.restore(issue().state);
    expect(() => invitation.replaceableAt(NOW, 0)).toThrow(RangeError);
    expect(() => invitation.replaceableAt(NOW, 1.5)).toThrow(RangeError);
  });
});
