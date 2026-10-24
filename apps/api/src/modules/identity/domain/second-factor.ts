import { err, ok } from '@mondapac-drive/shared-kernel';
import type { Id, MarketId, PendingEvent, Result, Temporal } from '@mondapac-drive/shared-kernel';
import { SecondFactorChanged, type SecondFactorChange } from './events';
import { RECOVERY_CODES } from './recovery-code';
import { stepIsFresh } from './totp';

/** `none` is no row (data design 3.10). */
export const SECOND_FACTOR_STATES = ['pending', 'active'] as const;
export type SecondFactorStateCode = (typeof SECOND_FACTOR_STATES)[number];

/** One stored recovery code: its position (1 to 10) and its keyed hash, never the code. */
export interface StoredRecoveryCode {
  readonly position: number;
  /** `SubjectKeyService.hmac` of the canonical code under the account's key (32 bytes, H2). */
  readonly codeHash: Uint8Array;
  readonly usedAt: Temporal.Instant | null;
}

/** The state of a {@link SecondFactor} (identity design 2.1, 3.6; data design 3.10). */
export interface SecondFactorState {
  /** New for every enrolment (M3). */
  readonly id: Id<'SecondFactor'>;
  readonly marketId: MarketId;
  readonly accountId: Id<'Account'>;
  readonly state: SecondFactorStateCode;
  /** The secret, encrypted with the account's subject key; never the secret (7.5). */
  readonly secretCiphertext: string;
  /** A replacement device's secret waiting for its first valid code (M13); active only. */
  readonly pendingSecretCiphertext: string | null;
  readonly lastAcceptedStep: number | null;
  readonly activatedAt: Temporal.Instant | null;
  /** The instant of the last HF2 lock (6.8); the lock itself is the counter. */
  readonly lockedAt: Temporal.Instant | null;
  readonly createdAt: Temporal.Instant;
  /** Empty while pending; exactly ten once active. */
  readonly recoveryCodes: readonly StoredRecoveryCode[];
  readonly version: number;
}

/** Why a factor change was refused. One code: the caller answers the user its own code. */
export type SecondFactorRefused = {
  readonly code: 'second-factor.refused';
  readonly reason: 'wrong-state' | 'step-not-fresh' | 'no-replacement' | 'code-spent';
};

/** A factor that would break an invariant of 3.10: a programmer error, never a user's. */
export class SecondFactorInvariantError extends Error {
  override readonly name = 'SecondFactorInvariantError';
  constructor(detail: string) {
    super(`identity.second_factors: ${detail}`);
  }
}

const refused = (reason: SecondFactorRefused['reason']): SecondFactorRefused =>
  Object.freeze({ code: 'second-factor.refused', reason });

/**
 * The `SecondFactor` aggregate (identity design 2.1, 3.6, 7; data design 3.10). One per
 * account; a new id at every enrolment (M3); `none` is the absence of the row, so a reset is the
 * repository's removal, never a state here.
 *
 * - `createActive`: an admin's first factor, created inside the acceptance of its invitation
 *   once a valid code arrived (3.4, HF6): nothing is stored before that, and the step of that
 *   code is already spent, so it cannot open a session afterwards.
 * - `startEnrolment` / `activate`: every other enrolment, from a mailed link (3.6, HF6).
 * - `acceptStep`: a time step is accepted once (7.1); the repository's guarded update is the
 *   guarantee under concurrency, this is the same rule in memory.
 * - `startReplacement` / `completeReplacement`: a new device (M13): the new secret waits beside
 *   the active one until its first valid code.
 * - `regenerateRecoveryCodes`: ten new codes; the old ones stop working.
 * - `recordLock`: the instant of an HF2 lock, so its event can send the alert (6.8).
 *
 * - `recordReset`: the last version step of a factor that a reset removes (3.6 `active` →
 *   `none`); the repository then deletes the row.
 *
 * Secrets never enter this class in clear: it holds ciphertext and keyed hashes only. Every
 * change raises the version by one (C5). `identity.second-factor-changed.v1` (8.2, slice 7b) is
 * recorded on the steps the holder must know of: `activated`, `replaced`,
 * `recovery-codes-regenerated`, `reset` and `locked`; a spent step or code, a waiting
 * replacement and its clearing record none.
 */
export class SecondFactor {
  #state: SecondFactorState;
  #events: PendingEvent[] = [];

  private constructor(
    state: SecondFactorState,
    /** The version read from the store; null for a factor not stored yet. */
    readonly persistedVersion: number | null,
  ) {
    SecondFactor.check(state);
    this.#state = SecondFactor.freeze(state);
  }

  /** An active factor with its ten codes, from the code that proved the device (3.4, HF6). */
  static createActive(input: {
    readonly id: Id<'SecondFactor'>;
    readonly marketId: MarketId;
    readonly accountId: Id<'Account'>;
    readonly secretCiphertext: string;
    /** The time step of the code that activated it: spent from the start. */
    readonly acceptedStep: number;
    readonly recoveryCodeHashes: readonly Uint8Array[];
    readonly now: Temporal.Instant;
  }): SecondFactor {
    if (!stepIsFresh(input.acceptedStep, null)) {
      throw new SecondFactorInvariantError('an accepted step is a whole number from 0');
    }
    const factor = new SecondFactor(
      {
        id: input.id,
        marketId: input.marketId,
        accountId: input.accountId,
        state: 'active',
        secretCiphertext: input.secretCiphertext,
        pendingSecretCiphertext: null,
        lastAcceptedStep: input.acceptedStep,
        activatedAt: input.now,
        lockedAt: null,
        createdAt: input.now,
        recoveryCodes: freshCodes(input.recoveryCodeHashes),
        version: 1,
      },
      null,
    );
    factor.record('activated', input.now);
    return factor;
  }

  /** A pending factor: the secret is stored, the device not yet proved (3.6 `none` → `pending`). */
  static startEnrolment(input: {
    readonly id: Id<'SecondFactor'>;
    readonly marketId: MarketId;
    readonly accountId: Id<'Account'>;
    readonly secretCiphertext: string;
    readonly now: Temporal.Instant;
  }): SecondFactor {
    return new SecondFactor(
      {
        id: input.id,
        marketId: input.marketId,
        accountId: input.accountId,
        state: 'pending',
        secretCiphertext: input.secretCiphertext,
        pendingSecretCiphertext: null,
        lastAcceptedStep: null,
        activatedAt: null,
        lockedAt: null,
        createdAt: input.now,
        recoveryCodes: [],
        version: 1,
      },
      null,
    );
  }

  static restore(state: SecondFactorState): SecondFactor {
    return new SecondFactor(state, state.version);
  }

  get state(): SecondFactorState {
    return this.#state;
  }

  get isActive(): boolean {
    return this.#state.state === 'active';
  }

  /** Events recorded since the factor was built or restored. */
  get pendingEvents(): readonly PendingEvent[] {
    return [...this.#events];
  }

  /** The unused recovery codes, by position. */
  get unusedRecoveryCodes(): readonly StoredRecoveryCode[] {
    return this.#state.recoveryCodes.filter((code) => code.usedAt === null);
  }

  /** `pending` → `active` with a valid code of the stored secret (3.6). */
  activate(input: {
    readonly acceptedStep: number;
    readonly recoveryCodeHashes: readonly Uint8Array[];
    readonly now: Temporal.Instant;
  }): Result<void, SecondFactorRefused> {
    if (this.#state.state !== 'pending') return err(refused('wrong-state'));
    if (!stepIsFresh(input.acceptedStep, this.#state.lastAcceptedStep)) {
      return err(refused('step-not-fresh'));
    }
    this.change({
      state: 'active',
      lastAcceptedStep: input.acceptedStep,
      activatedAt: input.now,
      recoveryCodes: freshCodes(input.recoveryCodeHashes),
    });
    this.record('activated', input.now);
    return ok(undefined);
  }

  /** A valid code of the active secret at `step`: accepted once (7.1). */
  acceptStep(step: number): Result<void, SecondFactorRefused> {
    if (this.#state.state !== 'active') return err(refused('wrong-state'));
    if (!stepIsFresh(step, this.#state.lastAcceptedStep)) return err(refused('step-not-fresh'));
    this.change({ lastAcceptedStep: step });
    return ok(undefined);
  }

  /** The unused code at `position` is spent (7.3); the repository's guarded update decides. */
  useRecoveryCode(position: number, now: Temporal.Instant): Result<void, SecondFactorRefused> {
    if (this.#state.state !== 'active') return err(refused('wrong-state'));
    const codes = this.#state.recoveryCodes;
    const code = codes.find((candidate) => candidate.position === position);
    if (code === undefined) return err(refused('wrong-state'));
    if (code.usedAt !== null) return err(refused('code-spent'));
    this.change({
      recoveryCodes: codes.map((candidate) =>
        candidate.position === position ? { ...candidate, usedAt: now } : candidate,
      ),
    });
    return ok(undefined);
  }

  /** A new device's secret waits beside the active one (M13); a new start replaces a waiting one. */
  startReplacement(pendingSecretCiphertext: string): Result<void, SecondFactorRefused> {
    if (this.#state.state !== 'active') return err(refused('wrong-state'));
    this.change({ pendingSecretCiphertext });
    return ok(undefined);
  }

  /**
   * The first valid code of the new device swaps the secrets in one change (M13): the old
   * secret is void. `step` is the step of that code, spent like any other.
   */
  completeReplacement(step: number, now: Temporal.Instant): Result<void, SecondFactorRefused> {
    const { state, pendingSecretCiphertext, lastAcceptedStep } = this.#state;
    if (state !== 'active') return err(refused('wrong-state'));
    if (pendingSecretCiphertext === null) return err(refused('no-replacement'));
    if (!stepIsFresh(step, lastAcceptedStep)) return err(refused('step-not-fresh'));
    this.change({
      secretCiphertext: pendingSecretCiphertext,
      pendingSecretCiphertext: null,
      lastAcceptedStep: step,
    });
    this.record('replaced', now);
    return ok(undefined);
  }

  /** A waiting replacement is dropped (a password change, D 3.6). Answers whether there was one. */
  clearReplacement(): boolean {
    if (this.#state.pendingSecretCiphertext === null) return false;
    this.change({ pendingSecretCiphertext: null });
    return true;
  }

  /** Ten new codes; every earlier one stops working (3.6). */
  regenerateRecoveryCodes(
    hashes: readonly Uint8Array[],
    now: Temporal.Instant,
  ): Result<void, SecondFactorRefused> {
    if (this.#state.state !== 'active') return err(refused('wrong-state'));
    this.change({ recoveryCodes: freshCodes(hashes) });
    this.record('recovery-codes-regenerated', now);
    return ok(undefined);
  }

  /** The instant of an HF2 lock (6.8): the counter is the lock; this drives the alert. */
  recordLock(now: Temporal.Instant): void {
    this.change({ lockedAt: now });
    this.record('locked', now);
  }

  /**
   * A reset returns the factor to `none` (3.6, 7.3): the repository deletes the row in the same
   * unit. This is its last version step, so the event names a version the factor never had
   * before, and the next enrolment gets a new id (M3).
   */
  recordReset(now: Temporal.Instant): void {
    this.change({});
    this.record('reset', now);
  }

  private record(change: SecondFactorChange, now: Temporal.Instant): void {
    const { id, accountId, version } = this.#state;
    this.#events.push(
      SecondFactorChanged.record({
        aggregateId: id,
        aggregateVersion: version,
        occurredAt: now,
        payload: { accountId, change },
      }),
    );
  }

  private change(fields: Partial<SecondFactorState>): void {
    const next = { ...this.#state, ...fields, version: this.#state.version + 1 };
    SecondFactor.check(next);
    this.#state = SecondFactor.freeze(next);
  }

  /** The invariants of data design 3.10, checked on every state, restored ones included. */
  private static check(state: SecondFactorState): void {
    if (!(SECOND_FACTOR_STATES as readonly string[]).includes(state.state)) {
      throw new SecondFactorInvariantError('unknown state');
    }
    if ((state.state === 'active') !== (state.activatedAt !== null)) {
      throw new SecondFactorInvariantError('activated_at is set if and only if active');
    }
    if (state.pendingSecretCiphertext !== null && state.state !== 'active') {
      throw new SecondFactorInvariantError('a replacement waits only beside an active factor');
    }
    if (state.secretCiphertext.length === 0 || state.pendingSecretCiphertext === '') {
      throw new SecondFactorInvariantError('a secret is never empty');
    }
    if (
      state.lastAcceptedStep !== null &&
      (!Number.isSafeInteger(state.lastAcceptedStep) || state.lastAcceptedStep < 0)
    ) {
      throw new SecondFactorInvariantError('a time step is a whole number from 0');
    }
    const codes = state.recoveryCodes;
    const expected = state.state === 'active' ? RECOVERY_CODES.count : 0;
    // Codes are spent by marking them, never by deleting a row: an active factor has all ten.
    if (codes.length !== expected) {
      throw new SecondFactorInvariantError(`an ${state.state} factor has ${expected} codes`);
    }
    const positions = new Set(codes.map((code) => code.position));
    if (
      positions.size !== codes.length ||
      codes.some(
        (code) =>
          !Number.isInteger(code.position) ||
          code.position < 1 ||
          code.position > RECOVERY_CODES.count ||
          code.codeHash.length !== 32,
      )
    ) {
      throw new SecondFactorInvariantError('codes are positions 1 to 10 with 32-byte hashes');
    }
    if (state.version < 1 || !Number.isInteger(state.version)) {
      throw new SecondFactorInvariantError('the version is a whole number from 1');
    }
  }

  private static freeze(state: SecondFactorState): SecondFactorState {
    return Object.freeze({
      ...state,
      recoveryCodes: Object.freeze(
        [...state.recoveryCodes]
          .sort((a, b) => a.position - b.position)
          .map((code) => Object.freeze({ ...code, codeHash: Uint8Array.from(code.codeHash) })),
      ),
    });
  }
}

/** The bytes as lower-case hex, to compare hashes by value (no Node API in the domain). */
const hexOf = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');

/**
 * Ten unused codes at positions 1 to 10, in the order given. Ten distinct codes have ten
 * distinct hashes, so a repeated hash is a generator fault and is refused (Hassan L-3): one code
 * would otherwise sit at two positions and could be spent twice.
 */
function freshCodes(hashes: readonly Uint8Array[]): StoredRecoveryCode[] {
  if (hashes.length !== RECOVERY_CODES.count) {
    throw new SecondFactorInvariantError(`exactly ${RECOVERY_CODES.count} recovery codes`);
  }
  if (new Set(hashes.map(hexOf)).size !== hashes.length) {
    throw new SecondFactorInvariantError('the recovery codes are distinct');
  }
  return hashes.map((codeHash, index) => ({
    position: index + 1,
    codeHash: Uint8Array.from(codeHash),
    usedAt: null,
  }));
}
