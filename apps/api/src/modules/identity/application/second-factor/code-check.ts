import type { Logger } from '@nestjs/common';
import { Temporal } from '@mondapac-drive/shared-kernel';
import type {
  CallContext,
  Clock,
  Id,
  MarketContext,
  Population,
} from '@mondapac-drive/shared-kernel';
import type { OutboxWriter } from '../../../../platform/events/outbox-writer';
import { parseRecoveryCode, type RecoveryCode } from '../../domain/recovery-code';
import {
  blockAfterFailure,
  reservationVerdict,
  type ThrottleReservation,
  type ThrottleRule,
} from '../../domain/throttle';
import { candidateSteps, parseTotpCode } from '../../domain/totp';
import type { SecondFactorSecrets } from '../ports/second-factor-secrets';
import type { SecondFactorRepository } from '../ports/second-factor.repository';
import type { ThrottleKeys } from '../ports/session-secrets';
import type { ThrottleCounter, ThrottleRepository } from '../ports/throttle.repository';

/** A code as the person typed it: six digits from the app, or a recovery code (7.1, 7.3). */
export type PresentedCode =
  | { readonly kind: 'totp'; readonly code: string }
  | { readonly kind: 'recovery'; readonly code: RecoveryCode };

/**
 * Reads one code field: six digits (with one inner space or hyphen) is an app code, ten symbols of
 * Crockford's alphabet a recovery code; the two shapes never overlap. Null for anything else.
 */
export function parsePresentedCode(raw: unknown, allowRecovery = true): PresentedCode | null {
  const totp = parseTotpCode(raw);
  if (totp !== null) return { kind: 'totp', code: totp };
  if (!allowRecovery) return null;
  const recovery = parseRecoveryCode(raw);
  return recovery === null ? null : { kind: 'recovery', code: recovery };
}

/**
 * What the check outside any unit found. An app code that matched names its time step, which the
 * closing unit accepts once (`acceptStep`); a recovery code is its keyed hash, which the closing
 * unit spends only if an unused code has it (`useRecoveryCode`). Either can still lose there.
 */
export type CodeCheck =
  | { readonly kind: 'totp'; readonly step: number }
  | { readonly kind: 'recovery'; readonly codeHash: Uint8Array }
  | { readonly kind: 'no-match' };

const NO_MATCH: CodeCheck = Object.freeze({ kind: 'no-match' });

/**
 * Checks a presented code against a sealed secret, outside any unit (identity design 6.3, 7.1).
 *
 * - Hassan I-2: the steps always come from `candidateSteps(clock.now())`, never from input.
 * - Hassan I-3: a secret that cannot be used, because its key was destroyed, it fails its
 *   integrity check or the key service is unreachable, gives the same answer as a wrong code (the
 *   caller counts the attempt) and logs an integrity alarm with the error's class name only.
 */
export async function checkPresentedCode(
  deps: { readonly secrets: SecondFactorSecrets; readonly clock: Clock },
  logger: Logger,
  context: CallContext,
  accountId: Id<'Account'>,
  secretCiphertext: string,
  presented: PresentedCode,
): Promise<CodeCheck> {
  try {
    if (presented.kind === 'totp') {
      const step = await deps.secrets.matchStored(
        context.market,
        accountId,
        secretCiphertext,
        presented.code,
        candidateSteps(deps.clock.now()),
      );
      return step === null ? NO_MATCH : { kind: 'totp', step };
    }
    const codeHash = await deps.secrets.recoveryCodeHash(context.market, accountId, presented.code);
    return { kind: 'recovery', codeHash };
  } catch (error) {
    logger.error({
      msg: 'identity.second-factor.secret-unusable',
      alarm: 'integrity',
      reason: error instanceof Error ? error.name : 'unknown',
      accountId,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return NO_MATCH;
  }
}

/**
 * Whether an attempt is given back when the work after the check fails and keeps nothing (a
 * closing unit that throws, a `prepare` or a hash that fails; HF2; Mojtaba and Hassan, PR #162):
 * only for a code proven correct. An app code is proven by its match outside the unit; a
 * recovery code only by a spend that the closing unit accepted before it failed, since
 * {@link checkPresentedCode} answers `recovery` for any well-formed one. A wrong code, or a
 * recovery code not yet spent, stays counted.
 */
export function codeProven(check: CodeCheck | null, recoverySpent: boolean): boolean {
  if (check === null) return false;
  return check.kind === 'totp' || (check.kind === 'recovery' && recoverySpent);
}

/**
 * Spends what {@link checkPresentedCode} found, in the closing unit: a step accepted once by its
 * guarded statement, or an unused recovery code spent once. False when it lost (a replayed or
 * concurrent code, a spent or unknown recovery code) or there was no match.
 */
export async function spendCode(
  factors: SecondFactorRepository,
  market: MarketContext,
  factorId: Id<'SecondFactor'>,
  check: CodeCheck,
  now: Temporal.Instant,
): Promise<boolean> {
  if (check.kind === 'totp') return factors.acceptStep(market, factorId, check.step);
  if (check.kind === 'recovery')
    return factors.useRecoveryCode(market, factorId, check.codeHash, now);
  return false;
}

/**
 * The `second-factor.account` counter of an account (identity design 6.8, HF2): failed codes and
 * recovery codes across challenges, keyed like the address counters, so `clearAccount` (which
 * deletes only the sign-in kinds) never touches it (Hassan I-4).
 */
export function secondFactorCounter(
  keys: ThrottleKeys,
  market: MarketContext,
  population: Population,
  emailNormalized: string,
  rule: ThrottleRule,
): ThrottleCounter {
  const accountKey = keys.account(market, population, emailNormalized);
  return { kind: 'second-factor.account', keyHash: accountKey, accountKey, rule };
}

/** The wait a locked factor announces (HF2, 6.3 step 5), or null when it is not locked at `now`. */
export function lockedFor(
  lockedAt: Temporal.Instant | null,
  rule: ThrottleRule,
  now: Temporal.Instant,
): number | null {
  if (lockedAt === null) return null;
  const until = lockedAt.add({ minutes: rule.blockMinutes });
  if (Temporal.Instant.compare(until, now) <= 0) return null;
  return Math.max(1, Math.ceil(now.until(until).total({ unit: 'seconds' })));
}

/**
 * A failed code in the closing unit (HF2, 6.8): the attempt stays counted; the attempt that
 * reaches the limit blocks the counter until its block ends, and locks the factor
 * (`SecondFactor.recordLock`), whose `locked` event sends the alert mail (item C). Nothing here
 * lifts a block. Answers whether this failure locked the factor.
 */
export async function recordCodeFailure(
  deps: {
    readonly throttles: ThrottleRepository;
    readonly factors: SecondFactorRepository;
    readonly outbox: OutboxWriter;
  },
  context: CallContext,
  reserved: { readonly reservation: ThrottleReservation; readonly rule: ThrottleRule },
  accountId: Id<'Account'>,
  now: Temporal.Instant,
): Promise<boolean> {
  const { reservation, rule } = reserved;
  const until = blockAfterFailure(reservation, rule, now);
  if (until === null) return false;
  await deps.throttles.block(context.market, [{ reservation, until }]);
  // Only the attempt that reached the limit locks: later ones were refused before any check.
  if (reservation.attempts !== rule.limit) return false;
  const factor = await deps.factors.findByAccount(context.market, accountId);
  if (factor === null) return false;
  factor.recordLock(now);
  await deps.factors.save(context.market, factor);
  await deps.outbox.append(context, factor.pendingEvents);
  return true;
}

/** One reserved counter attempt and its rule. */
export type ReservedAttempt = {
  readonly reservation: ThrottleReservation;
  readonly rule: ThrottleRule;
};

/** A reserved `second-factor.account` attempt, or the wait when the counter refuses it. */
export type SecondFactorReservation =
  | { readonly kind: 'reserved'; readonly reserved: ReservedAttempt }
  | { readonly kind: 'locked'; readonly retryAfterSeconds: number };

/**
 * Reserves one attempt on the `second-factor.account` counter before a code is checked (HF1,
 * HF2; identity design 6.8), in the caller's open unit. A counter at its limit, or blocked,
 * refuses with the wait; the attempt then stays counted, as a throttled sign-in does.
 */
export async function reserveSecondFactor(
  throttles: ThrottleRepository,
  market: MarketContext,
  counter: ThrottleCounter,
  now: Temporal.Instant,
): Promise<SecondFactorReservation> {
  const [reservation] = await throttles.reserve(market, [counter], now);
  const reserved = { reservation: reservation!, rule: counter.rule };
  const verdict = reservationVerdict([reserved], now);
  return verdict.allowed
    ? { kind: 'reserved', reserved }
    : { kind: 'locked', retryAfterSeconds: verdict.retryAfterSeconds };
}

/**
 * Ten new recovery codes and their keyed hashes under the account's key (identity design 7.3,
 * H2). Runs outside a unit, or inside the unit that created the account's key (the service reads
 * the open unit's key, PF 4 row 8). The codes are shown once to their owner and never stored.
 */
export async function newRecoveryCodes(
  secrets: SecondFactorSecrets,
  market: MarketContext,
  accountId: Id<'Account'>,
): Promise<{ readonly codes: readonly RecoveryCode[]; readonly hashes: readonly Uint8Array[] }> {
  const codes = secrets.newRecoveryCodes();
  const hashes: Uint8Array[] = [];
  for (const code of codes) hashes.push(await secrets.recoveryCodeHash(market, accountId, code));
  return { codes, hashes };
}
