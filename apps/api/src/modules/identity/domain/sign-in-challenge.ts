import { Temporal } from '@mondapac-drive/shared-kernel';
import type { Id, MarketId } from '@mondapac-drive/shared-kernel';

/** What a challenge leads to (data design 3.10): a session, or an active factor (enrolment). */
export const CHALLENGE_PURPOSES = ['second-factor', 'second-factor-enrolment'] as const;
export type ChallengePurpose = (typeof CHALLENGE_PURPOSES)[number];

/**
 * The challenge policy of a Market (identity design 2.1, 6.8): attempts per challenge (Hassan:
 * five) and the lifetime (five minutes). Policy values, read from Market configuration by the
 * use case that issues or checks a challenge; never literals here.
 */
export interface ChallengePolicy {
  readonly maxAttempts: number;
  readonly lifetimeSeconds: number;
}

/**
 * A sign-in challenge (identity design 2.1, 6.3 step 5; data design 3.10): the state between a
 * correct password and a session or an active factor. It is never a credential and never an
 * actor (I1): the request that holds it stays anonymous. Not versioned (M1): it changes only
 * by single guarded statements, an attempt reserved before the code is checked (HF1) and the
 * consumption. Only the SHA-256 of its token is stored, by the repository.
 */
export interface SignInChallenge {
  readonly id: Id<'SignInChallenge'>;
  readonly marketId: MarketId;
  readonly accountId: Id<'Account'>;
  readonly purpose: ChallengePurpose;
  /** Reserved attempts so far. */
  readonly attempts: number;
  /** The credential's `changedAt` at issue: the closing unit compares it (HF11). */
  readonly credentialChangedAt: Temporal.Instant;
  readonly expiresAt: Temporal.Instant;
  readonly consumedAt: Temporal.Instant | null;
  readonly createdAt: Temporal.Instant;
}

/** A challenge refused a policy that cannot hold (a configuration error caught at boot too). */
export class ChallengePolicyError extends Error {
  override readonly name = 'ChallengePolicyError';
  constructor() {
    super('A challenge needs a positive whole number of attempts and a positive lifetime');
  }
}

/** Whether a policy can hold: at least one attempt and a lifetime of at least one second. */
export function checkChallengePolicy(policy: ChallengePolicy): void {
  if (
    !Number.isInteger(policy.maxAttempts) ||
    policy.maxAttempts < 1 ||
    policy.maxAttempts > 32767 ||
    !Number.isInteger(policy.lifetimeSeconds) ||
    policy.lifetimeSeconds < 1
  ) {
    throw new ChallengePolicyError();
  }
}

/**
 * Issues a challenge after a correct password (identity design 6.3 step 5): no attempt yet, an
 * expiry `policy.lifetimeSeconds` from now, and the credential's `changedAt` as it was read, so
 * a password changed in between voids it even if the deletion of 3.10 were missed (HF11).
 */
export function issueChallenge(input: {
  readonly id: Id<'SignInChallenge'>;
  readonly marketId: MarketId;
  readonly accountId: Id<'Account'>;
  readonly purpose: ChallengePurpose;
  readonly credentialChangedAt: Temporal.Instant;
  readonly policy: ChallengePolicy;
  readonly now: Temporal.Instant;
}): SignInChallenge {
  checkChallengePolicy(input.policy);
  return Object.freeze({
    id: input.id,
    marketId: input.marketId,
    accountId: input.accountId,
    purpose: input.purpose,
    attempts: 0,
    credentialChangedAt: input.credentialChangedAt,
    expiresAt: input.now.add({ seconds: input.policy.lifetimeSeconds }),
    consumedAt: null,
    createdAt: input.now,
  });
}

/**
 * Whether a challenge may still take an attempt at `now` for this purpose: unconsumed, before
 * its expiry and below the attempt limit. The repository's guarded reservation is what holds
 * under concurrency (HF1); this is the same rule in memory.
 */
export function challengeIsOpen(
  challenge: SignInChallenge,
  purpose: ChallengePurpose,
  policy: ChallengePolicy,
  now: Temporal.Instant,
): boolean {
  return (
    challenge.purpose === purpose &&
    challenge.consumedAt === null &&
    challenge.attempts < policy.maxAttempts &&
    Temporal.Instant.compare(now, challenge.expiresAt) < 0
  );
}

/**
 * Whether the credential the challenge was issued for is still the account's (HF11): the
 * closing unit refuses a challenge whose password changed meanwhile.
 */
export function challengeMatchesCredential(
  challenge: SignInChallenge,
  credentialChangedAt: Temporal.Instant,
): boolean {
  return Temporal.Instant.compare(challenge.credentialChangedAt, credentialChangedAt) === 0;
}
