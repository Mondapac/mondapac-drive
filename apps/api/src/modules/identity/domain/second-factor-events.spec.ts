import { parseId, parseMarketId, Temporal } from '@mondapac-drive/shared-kernel';
import type { Id, MarketId, PendingEvent } from '@mondapac-drive/shared-kernel';
import { SecondFactor } from './second-factor';

// Slice 7b: the events of the SecondFactor aggregate (identity design 3.6, 6.8, 8.2). One event
// per version step that changes what the account holder must know: activated, replaced,
// recovery codes regenerated, reset (the factor returns to `none`) and locked (HF2). A spent
// step, a spent recovery code, a waiting replacement and its clearing record none.

const NOW = Temporal.Instant.from('2026-10-08T10:00:00Z');
const LATER = Temporal.Instant.from('2026-10-08T10:05:00Z');

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

const FACTOR_ID = id<'SecondFactor'>('01990000-0000-7000-8000-0000000000f1');
const ACCOUNT_ID = id<'Account'>('01990000-0000-7000-8000-000000000001');
const hashes = (seed: number) =>
  Array.from({ length: 10 }, (_, k) => new Uint8Array(32).fill(seed + k));

const summary = (events: readonly PendingEvent[]) =>
  events.map((event) => ({
    type: event.type,
    aggregateType: event.aggregateType,
    aggregateId: event.aggregateId,
    aggregateVersion: event.aggregateVersion,
    occurredAt: event.occurredAt.toString(),
    payload: event.payload,
  }));

describe.each(['AU', 'ZZ'] as const)('SecondFactor events in market %s (slice 7b)', (code) => {
  const marketId = market(code);
  const active = () =>
    SecondFactor.createActive({
      id: FACTOR_ID,
      marketId,
      accountId: ACCOUNT_ID,
      secretCiphertext: 'cipher-a',
      acceptedStep: 100,
      recoveryCodeHashes: hashes(1),
      now: NOW,
    });
  const stored = () => SecondFactor.restore(active().state);

  it('records `activated` when an admin factor is created active (3.4, HF6)', () => {
    expect(summary(active().pendingEvents)).toEqual([
      {
        type: 'identity.second-factor-changed.v1',
        aggregateType: 'second-factor',
        aggregateId: FACTOR_ID,
        aggregateVersion: 1,
        occurredAt: NOW.toString(),
        payload: { accountId: ACCOUNT_ID, change: 'activated' },
      },
    ]);
  });

  it('records `activated` when a pending enrolment is activated (3.6)', () => {
    const pending = SecondFactor.restore(
      SecondFactor.startEnrolment({
        id: FACTOR_ID,
        marketId,
        accountId: ACCOUNT_ID,
        secretCiphertext: 'cipher-a',
        now: NOW,
      }).state,
    );
    expect(pending.pendingEvents).toEqual([]);
    expect(
      pending.activate({ acceptedStep: 101, recoveryCodeHashes: hashes(1), now: LATER }).ok,
    ).toBe(true);
    expect(summary(pending.pendingEvents)).toEqual([
      expect.objectContaining({
        aggregateVersion: 2,
        occurredAt: LATER.toString(),
        payload: { accountId: ACCOUNT_ID, change: 'activated' },
      }),
    ]);
  });

  it('records nothing for a spent step, a spent code, or a waiting replacement', () => {
    const factor = stored();
    expect(factor.acceptStep(101).ok).toBe(true);
    expect(factor.useRecoveryCode(1, LATER).ok).toBe(true);
    expect(factor.startReplacement('cipher-b').ok).toBe(true);
    expect(factor.clearReplacement()).toBe(true);
    expect(factor.pendingEvents).toEqual([]);
  });

  it('records `replaced` when the new device swaps in (M13)', () => {
    const factor = stored();
    expect(factor.startReplacement('cipher-b').ok).toBe(true);
    expect(factor.completeReplacement(101, LATER).ok).toBe(true);
    expect(summary(factor.pendingEvents)).toEqual([
      expect.objectContaining({
        aggregateVersion: 3,
        payload: { accountId: ACCOUNT_ID, change: 'replaced' },
      }),
    ]);
  });

  it('records `recovery-codes-regenerated` (3.6)', () => {
    const factor = stored();
    expect(factor.regenerateRecoveryCodes(hashes(50), LATER).ok).toBe(true);
    expect(summary(factor.pendingEvents)).toEqual([
      expect.objectContaining({
        aggregateVersion: 2,
        payload: { accountId: ACCOUNT_ID, change: 'recovery-codes-regenerated' },
      }),
    ]);
  });

  it('records `locked` with the lock instant (HF2, 6.8)', () => {
    const factor = stored();
    factor.recordLock(LATER);
    expect(factor.state.lockedAt).toEqual(LATER);
    expect(summary(factor.pendingEvents)).toEqual([
      expect.objectContaining({
        aggregateVersion: 2,
        occurredAt: LATER.toString(),
        payload: { accountId: ACCOUNT_ID, change: 'locked' },
      }),
    ]);
  });

  it('records `reset` as the last version step before the row is removed (3.6 `active` → `none`)', () => {
    const factor = stored();
    factor.recordReset(LATER);
    expect(factor.state.version).toBe(2);
    expect(summary(factor.pendingEvents)).toEqual([
      expect.objectContaining({
        aggregateVersion: 2,
        payload: { accountId: ACCOUNT_ID, change: 'reset' },
      }),
    ]);
  });

  it('refuses a replacement swap or a regeneration on a pending factor, recording nothing', () => {
    const pending = SecondFactor.startEnrolment({
      id: FACTOR_ID,
      marketId,
      accountId: ACCOUNT_ID,
      secretCiphertext: 'cipher-a',
      now: NOW,
    });
    expect(pending.completeReplacement(101, LATER).ok).toBe(false);
    expect(pending.regenerateRecoveryCodes(hashes(50), LATER).ok).toBe(false);
    expect(pending.pendingEvents).toEqual([]);
  });
});
