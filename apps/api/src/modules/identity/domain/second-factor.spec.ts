import { parseId, parseMarketId, Temporal } from '@mondapac-drive/shared-kernel';
import type { Id, MarketId } from '@mondapac-drive/shared-kernel';
import { SecondFactor, SecondFactorInvariantError, type SecondFactorState } from './second-factor';

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

describe.each(['AU', 'ZZ'] as const)('SecondFactor in market %s (identity design 3.6)', (code) => {
  const marketId = market(code);
  const active = (step = 100) =>
    SecondFactor.createActive({
      id: FACTOR_ID,
      marketId,
      accountId: ACCOUNT_ID,
      secretCiphertext: 'cipher-a',
      acceptedStep: step,
      recoveryCodeHashes: hashes(1),
      now: NOW,
    });
  const stored = (factor: SecondFactor) => SecondFactor.restore(factor.state);

  it('creates an admin factor active, with ten unused codes and its activating step spent (HF6)', () => {
    const factor = active(100);
    expect(factor.state).toMatchObject({
      state: 'active',
      lastAcceptedStep: 100,
      activatedAt: NOW,
      pendingSecretCiphertext: null,
      lockedAt: null,
      version: 1,
    });
    expect(factor.persistedVersion).toBeNull();
    expect(factor.unusedRecoveryCodes.map((c) => c.position)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
    ]);
    expect(factor.acceptStep(100)).toEqual({
      ok: false,
      error: { code: 'second-factor.refused', reason: 'step-not-fresh' },
    });
  });

  it('accepts a later step once, and never an earlier or the same one (7.1)', () => {
    const factor = stored(active(100));
    expect(factor.acceptStep(101).ok).toBe(true);
    expect(factor.state.version).toBe(2);
    expect(factor.acceptStep(101).ok).toBe(false);
    expect(factor.acceptStep(99).ok).toBe(false);
    expect(factor.state.lastAcceptedStep).toBe(101);
    expect(factor.state.version).toBe(2);
  });

  it('starts an enrolment pending without codes, and activates it with a code (3.6)', () => {
    const factor = SecondFactor.startEnrolment({
      id: FACTOR_ID,
      marketId,
      accountId: ACCOUNT_ID,
      secretCiphertext: 'cipher-a',
      now: NOW,
    });
    expect(factor.isActive).toBe(false);
    expect(factor.state.recoveryCodes).toEqual([]);
    expect(factor.acceptStep(5).ok).toBe(false);
    expect(factor.activate({ acceptedStep: 7, recoveryCodeHashes: hashes(1), now: LATER })).toEqual(
      { ok: true, value: undefined },
    );
    expect(factor.state).toMatchObject({
      state: 'active',
      activatedAt: LATER,
      lastAcceptedStep: 7,
    });
    expect(factor.state.recoveryCodes).toHaveLength(10);
    expect(factor.activate({ acceptedStep: 8, recoveryCodeHashes: hashes(1), now: LATER }).ok).toBe(
      false,
    );
  });

  it('spends a recovery code once', () => {
    const factor = stored(active());
    expect(factor.useRecoveryCode(3, LATER).ok).toBe(true);
    // A spent code has its own reason (review nit); an unknown position is wrong-state.
    expect(factor.useRecoveryCode(3, LATER)).toEqual({
      ok: false,
      error: { code: 'second-factor.refused', reason: 'code-spent' },
    });
    expect(factor.useRecoveryCode(11, LATER)).toEqual({
      ok: false,
      error: { code: 'second-factor.refused', reason: 'wrong-state' },
    });
    expect(factor.unusedRecoveryCodes.map((c) => c.position)).not.toContain(3);
    expect(factor.state.recoveryCodes.find((c) => c.position === 3)?.usedAt).toEqual(LATER);
  });

  it('keeps a replacement secret beside the active one until its first code swaps them (M13)', () => {
    const factor = stored(active(100));
    expect(factor.completeReplacement(101, LATER)).toEqual({
      ok: false,
      error: { code: 'second-factor.refused', reason: 'no-replacement' },
    });
    expect(factor.startReplacement('cipher-b').ok).toBe(true);
    expect(factor.state).toMatchObject({
      secretCiphertext: 'cipher-a',
      pendingSecretCiphertext: 'cipher-b',
    });
    // A new start replaces a waiting secret.
    expect(factor.startReplacement('cipher-c').ok).toBe(true);
    expect(factor.completeReplacement(100, LATER).ok).toBe(false);
    expect(factor.completeReplacement(102, LATER).ok).toBe(true);
    expect(factor.state).toMatchObject({
      secretCiphertext: 'cipher-c',
      pendingSecretCiphertext: null,
      lastAcceptedStep: 102,
    });
    expect(factor.clearReplacement()).toBe(false);
    factor.startReplacement('cipher-d');
    expect(factor.clearReplacement()).toBe(true);
    expect(factor.state.pendingSecretCiphertext).toBeNull();
  });

  it('regenerates ten codes, so the old ones stop working', () => {
    const factor = stored(active());
    factor.useRecoveryCode(1, LATER);
    expect(factor.regenerateRecoveryCodes(hashes(50), LATER).ok).toBe(true);
    expect(factor.unusedRecoveryCodes).toHaveLength(10);
    expect(factor.state.recoveryCodes[0]!.codeHash).toEqual(new Uint8Array(32).fill(50));
  });

  it('records the instant of an HF2 lock', () => {
    const factor = stored(active());
    factor.recordLock(LATER);
    expect(factor.state.lockedAt).toEqual(LATER);
    expect(factor.state.version).toBe(2);
  });

  it.each<[string, Partial<SecondFactorState>]>([
    ['an active factor without its activation instant', { activatedAt: null }],
    ['a replacement beside a pending factor', { state: 'pending', activatedAt: null }],
    ['an active factor without its codes', { recoveryCodes: [] }],
    ['an empty secret', { secretCiphertext: '' }],
    ['a negative step', { lastAcceptedStep: -1 }],
    ['version 0', { version: 0 }],
  ])('never restores %s', (_name, change) => {
    const base = active().state;
    const broken: SecondFactorState = {
      ...base,
      pendingSecretCiphertext: change.state === 'pending' ? 'cipher-x' : null,
      ...change,
    };
    expect(() => SecondFactor.restore(broken)).toThrow(SecondFactorInvariantError);
  });

  it('refuses a code count other than ten, or a short hash', () => {
    expect(() =>
      SecondFactor.createActive({
        id: FACTOR_ID,
        marketId,
        accountId: ACCOUNT_ID,
        secretCiphertext: 'c',
        acceptedStep: 1,
        recoveryCodeHashes: hashes(1).slice(1),
        now: NOW,
      }),
    ).toThrow(SecondFactorInvariantError);
    expect(() =>
      SecondFactor.createActive({
        id: FACTOR_ID,
        marketId,
        accountId: ACCOUNT_ID,
        secretCiphertext: 'c',
        acceptedStep: 1,
        recoveryCodeHashes: [...hashes(1).slice(1), new Uint8Array(31)],
        now: NOW,
      }),
    ).toThrow(SecondFactorInvariantError);
  });

  it('refuses a repeated recovery-code hash, at activation, creation and regeneration (Hassan L-3)', () => {
    const repeated = [...hashes(1).slice(1), hashes(1)[0]!];
    repeated[9] = Uint8Array.from(repeated[0]!);
    expect(() =>
      SecondFactor.createActive({
        id: FACTOR_ID,
        marketId,
        accountId: ACCOUNT_ID,
        secretCiphertext: 'c',
        acceptedStep: 1,
        recoveryCodeHashes: repeated,
        now: NOW,
      }),
    ).toThrow(new SecondFactorInvariantError('the recovery codes are distinct'));
    const factor = stored(active());
    const before = factor.state;
    expect(() => factor.regenerateRecoveryCodes(repeated, LATER)).toThrow(
      SecondFactorInvariantError,
    );
    expect(factor.state).toBe(before);
    const pending = SecondFactor.startEnrolment({
      id: FACTOR_ID,
      marketId,
      accountId: ACCOUNT_ID,
      secretCiphertext: 'cipher-a',
      now: NOW,
    });
    expect(() =>
      pending.activate({ acceptedStep: 7, recoveryCodeHashes: repeated, now: LATER }),
    ).toThrow(SecondFactorInvariantError);
    expect(pending.isActive).toBe(false);
  });

  it('copies the hashes it is given, so a caller cannot change a stored hash', () => {
    const given = hashes(1);
    const factor = SecondFactor.createActive({
      id: FACTOR_ID,
      marketId,
      accountId: ACCOUNT_ID,
      secretCiphertext: 'c',
      acceptedStep: 1,
      recoveryCodeHashes: given,
      now: NOW,
    });
    given[0]!.fill(0);
    expect(factor.state.recoveryCodes[0]!.codeHash).toEqual(new Uint8Array(32).fill(1));
  });
});
