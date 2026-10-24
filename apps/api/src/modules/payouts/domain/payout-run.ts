import {
  addMoney,
  compareMoney,
  money,
  Temporal,
  type Id,
  type Money,
} from '@mondapac-drive/shared-kernel';
import { PayoutsDomainError } from './errors';
import type { Balance } from './ledger';
import type { Payee } from './payee';
import type { MarketPayoutSettings } from './payout-settings';

/**
 * A payout line's life. `pending` waits for its transfer; `transferred` reached the courier's
 * connected account; `failed` was refused for good, and its ledger debit is reversed; `reversed`
 * was taken back after the transfer, wholly or in part. `unresolved` ran out of attempts on
 * transient refusals: the provider may have made the transfer all the same, so its debit stands
 * until an operator settles it against the provider's records (never paid again blindly). `held`
 * was never paid (see {@link HoldReason}): nothing was debited, so the balance waits for a later
 * run.
 */
export const PAYOUT_LINE_STATUSES = [
  'pending',
  'held',
  'transferred',
  'failed',
  'unresolved',
  'reversed',
] as const;
export type PayoutLineStatus = (typeof PAYOUT_LINE_STATUSES)[number];

export const HOLD_REASONS = [
  'unknown-courier',
  'paid-by-payroll',
  'missing-business-id',
  'no-payout-account',
  'payouts-disabled',
] as const;
export type HoldReason = (typeof HOLD_REASONS)[number];

/** Transient refusals are retried by later ticks, at most this many attempts in all. */
export const MAX_TRANSFER_ATTEMPTS = 5;

/** A courier's connected account at the payment provider. Only its id is stored. */
export interface PayoutAccount {
  readonly courierId: string;
  readonly providerAccountId: string;
  /** The provider can pay this account out (onboarding finished and verified). */
  readonly payoutsEnabled: boolean;
  /**
   * When the provider produced the account state stored (its event's `created`): an older
   * `account.updated` that arrives later changes nothing (security review L1).
   */
  readonly providerStateAt?: Temporal.Instant;
  readonly createdAt: Temporal.Instant;
  readonly updatedAt: Temporal.Instant;
}

/** What one courier is paid by one run. `amount` is before tax; the transfer is `amount + tax`. */
export interface PayoutLine {
  readonly id: Id<'PayoutLine'>;
  readonly runId: Id<'PayoutRun'>;
  readonly courierId: string;
  readonly amount: Money;
  readonly tax: Money;
  readonly status: PayoutLineStatus;
  readonly holdReason?: HoldReason;
  /** The connected account paid; set when the line is pending. */
  readonly destination?: string;
  readonly transferId?: string;
  readonly attempts: number;
  /** The provider's last refusal code, for operators. */
  readonly lastErrorCode?: string;
  /** How much of the transfer the provider reports as taken back. */
  readonly reversedAmount: Money;
  readonly createdAt: Temporal.Instant;
  readonly updatedAt: Temporal.Instant;
  readonly version: number;
}

/** One payout run: every contractor balance owed at its cutoff. One run per cutoff and Market. */
export interface PayoutRun {
  readonly id: Id<'PayoutRun'>;
  readonly cutoff: Temporal.Instant;
  readonly currency: string;
  /** What the pending lines transfer, tax included. */
  readonly total: Money;
  readonly createdAt: Temporal.Instant;
}

export interface CourierBalance {
  readonly courierId: string;
  readonly balance: Balance;
}

export interface PayoutRunInput {
  readonly runId: Id<'PayoutRun'>;
  readonly cutoff: Temporal.Instant;
  readonly now: Temporal.Instant;
  /** Every courier's balance at the cutoff. */
  readonly balances: readonly CourierBalance[];
  readonly payees: ReadonlyMap<string, Payee>;
  readonly accounts: ReadonlyMap<string, PayoutAccount>;
  readonly newLineId: () => Id<'PayoutLine'>;
}

/** Why a balance is not paid, or `undefined` when it can be paid now. */
function holdReasonOf(
  settings: MarketPayoutSettings,
  payee: Payee | undefined,
  account: PayoutAccount | undefined,
): HoldReason | undefined {
  if (payee === undefined) return 'unknown-courier';
  if (payee.engagement === 'employee') return 'paid-by-payroll';
  if (settings.tax.businessIdRequired && !payee.businessIdVerified) return 'missing-business-id';
  if (account === undefined) return 'no-payout-account';
  if (!account.payoutsEnabled) return 'payouts-disabled';
  return undefined;
}

/**
 * Plans the run of one cutoff: one line per courier whose balance at the cutoff reaches the
 * Market's minimum. A line is `pending` when the courier is a contractor with a verified
 * business id (where the Market requires one) and a connected account that can be paid out, and
 * `held` with its reason otherwise. A balance below the minimum, zero or negative, gets no line
 * and waits for a later run. Lines are ordered by courier id.
 */
export function planPayoutRun(
  settings: MarketPayoutSettings,
  input: PayoutRunInput,
): { readonly run: PayoutRun; readonly lines: readonly PayoutLine[] } {
  const minimum = money(BigInt(settings.minimumPayout), settings.currency);
  const zero = money(0n, settings.currency);
  const lines: PayoutLine[] = [];
  const sorted = [...input.balances].sort((a, b) =>
    a.courierId < b.courierId ? -1 : a.courierId > b.courierId ? 1 : 0,
  );
  for (const { courierId, balance } of sorted) {
    if (balance.total.currency !== settings.currency) {
      throw new PayoutsDomainError('payouts.currency-mismatch', 'A balance is in another currency');
    }
    if (balance.total.amount <= 0n || compareMoney(balance.total, minimum) < 0) continue;
    const account = input.accounts.get(courierId);
    const holdReason = holdReasonOf(settings, input.payees.get(courierId), account);
    lines.push(
      Object.freeze({
        id: input.newLineId(),
        runId: input.runId,
        courierId,
        amount: balance.amount,
        tax: balance.tax,
        ...(holdReason === undefined
          ? { status: 'pending' as const, destination: account!.providerAccountId }
          : { status: 'held' as const, holdReason }),
        attempts: 0,
        reversedAmount: zero,
        createdAt: input.now,
        updatedAt: input.now,
        version: 1,
      }),
    );
  }
  const total = lines
    .filter((line) => line.status === 'pending')
    .reduce((sum, line) => addMoney(sum, transferAmountOf(line)), zero);
  return {
    run: Object.freeze({
      id: input.runId,
      cutoff: input.cutoff,
      currency: settings.currency,
      total,
      createdAt: input.now,
    }),
    lines,
  };
}

/** What the transfer of a line moves: its amount and its tax. */
export function transferAmountOf(line: PayoutLine): Money {
  return addMoney(line.amount, line.tax);
}

function next(line: PayoutLine, at: Temporal.Instant, change: Partial<PayoutLine>): PayoutLine {
  return Object.freeze({ ...line, ...change, updatedAt: at, version: line.version + 1 });
}

function requireStatus(line: PayoutLine, allowed: readonly PayoutLineStatus[]): void {
  if (!allowed.includes(line.status)) {
    throw new PayoutsDomainError(
      'payouts.line-state',
      `A ${line.status} payout line cannot change this way`,
    );
  }
}

/** The provider accepted the transfer. */
export function lineTransferred(
  line: PayoutLine,
  transferId: string,
  at: Temporal.Instant,
): PayoutLine {
  requireStatus(line, ['pending']);
  return next(line, at, { status: 'transferred', transferId, attempts: line.attempts + 1 });
}

/**
 * The provider refused the transfer. A permanent refusal fails the line, and its ledger debit
 * must then be reversed in the same unit. A transient refusal keeps it pending for a later tick;
 * the last of {@link MAX_TRANSFER_ATTEMPTS} makes it `unresolved` instead, its debit kept: a
 * timeout or a lost answer does not say the transfer was not made.
 */
export function lineRefused(
  line: PayoutLine,
  refusal: { readonly code: string; readonly transient: boolean },
  at: Temporal.Instant,
): PayoutLine {
  requireStatus(line, ['pending']);
  const attempts = line.attempts + 1;
  const status = !refusal.transient
    ? 'failed'
    : attempts >= MAX_TRANSFER_ATTEMPTS
      ? 'unresolved'
      : 'pending';
  return next(line, at, {
    status,
    attempts,
    lastErrorCode: refusal.code,
  });
}

/**
 * The provider reports `reversedTotal` of the transfer taken back (a running total). Answers the
 * line and the newly reversed portion, which the ledger credits back; zero when nothing changed.
 */
export function lineReversed(
  line: PayoutLine,
  reversedTotal: Money,
  at: Temporal.Instant,
): { readonly line: PayoutLine; readonly newlyReversed: Money } {
  requireStatus(line, ['transferred', 'reversed']);
  const transferred = transferAmountOf(line);
  if (reversedTotal.amount < 0n || compareMoney(reversedTotal, transferred) > 0) {
    throw new PayoutsDomainError(
      'payouts.invalid-reversal',
      'A reversal is between zero and the transfer',
    );
  }
  const newly = money(reversedTotal.amount - line.reversedAmount.amount, reversedTotal.currency);
  if (newly.amount <= 0n) return { line, newlyReversed: money(0n, reversedTotal.currency) };
  return {
    line: next(line, at, { status: 'reversed', reversedAmount: reversedTotal }),
    newlyReversed: newly,
  };
}

/**
 * A pending line whose account can no longer be paid out when its transfer is due (security
 * review L5): it is held instead, with the reason, and its ledger debit must be reversed in the
 * same unit so the balance waits for a later run.
 */
export function lineHeldBeforeTransfer(
  line: PayoutLine,
  reason: HoldReason,
  at: Temporal.Instant,
): PayoutLine {
  requireStatus(line, ['pending']);
  return next(line, at, { status: 'held', holdReason: reason });
}

/** An unresolved line an operator settled against the provider's records. */
export type Settlement =
  { readonly found: true; readonly transferId: string } | { readonly found: false };

/** The code an operator's settlement leaves on a line the provider never transferred. */
export const SETTLED_NOT_TRANSFERRED = 'settled.not-transferred';

/**
 * Settles an `unresolved` line: the provider holds a transfer for it, so it is `transferred`;
 * or it holds none, so the line is `failed` and its debit must be reversed in the same unit,
 * and the balance is paid by a later run under a new line.
 */
export function lineSettled(
  line: PayoutLine,
  settlement: Settlement,
  at: Temporal.Instant,
): PayoutLine {
  requireStatus(line, ['unresolved']);
  return settlement.found
    ? next(line, at, { status: 'transferred', transferId: settlement.transferId })
    : next(line, at, { status: 'failed', lastErrorCode: SETTLED_NOT_TRANSFERRED });
}

/**
 * The account after a provider report of its state produced at `stateAt`. Reports arrive in no
 * order (security review L1): one older than the state stored changes nothing (`undefined`).
 * Two reports of the same second (the provider's timestamps are second-granular) cannot be
 * ordered, so the account stays enabled only if both say so (fails closed, Hassan L-c): the
 * provider's next report enables it again.
 */
export function accountUpdated(
  account: PayoutAccount,
  report: { readonly payoutsEnabled: boolean; readonly stateAt: Temporal.Instant },
  at: Temporal.Instant,
): PayoutAccount | undefined {
  const stored = account.providerStateAt;
  const order = stored === undefined ? 1 : Temporal.Instant.compare(report.stateAt, stored);
  if (order < 0) return undefined;
  return Object.freeze({
    ...account,
    payoutsEnabled:
      order === 0 ? report.payoutsEnabled && account.payoutsEnabled : report.payoutsEnabled,
    providerStateAt: report.stateAt,
    updatedAt: at,
  });
}
