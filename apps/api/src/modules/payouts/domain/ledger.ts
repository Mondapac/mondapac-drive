import type { Temporal } from '@mondapac-drive/shared-kernel';
import { addMoney, money, subtractMoney, type Id, type Money } from '@mondapac-drive/shared-kernel';
import { PayoutsDomainError } from './errors';

/**
 * The kinds of ledger entry. Earnings, tips and adjustments credit (an adjustment may also
 * debit); a payout debits what a run pays; a reversal undoes all or part of an earlier entry.
 */
export const LEDGER_ENTRY_KINDS = ['earning', 'tip', 'adjustment', 'reversal', 'payout'] as const;
export type LedgerEntryKind = (typeof LEDGER_ENTRY_KINDS)[number];

/** Why an operator adjusted a balance: a code, never free text. */
export const ADJUSTMENT_REASONS = ['bonus', 'correction', 'damage-claim', 'other'] as const;
export type AdjustmentReason = (typeof ADJUSTMENT_REASONS)[number];

/** Why an entry was reversed. */
export const REVERSAL_REASONS = [
  'delivery-reversed',
  'transfer-failed',
  'transfer-reversed',
  'correction',
  /** The line was held before its transfer: the account could no longer be paid out (L5). */
  'payout-held',
] as const;
export type ReversalReason = (typeof REVERSAL_REASONS)[number];

/**
 * One line of a courier's append-only ledger. Entries are never changed or deleted: a mistake is
 * corrected by a reversal or an adjustment. `amount` is before tax, `tax` the indirect tax on it
 * (zero unless the courier is registered), both in the Market's settlement currency and with the
 * same sign. `reference` is the idempotency key: one entry per reference and Market.
 */
export interface LedgerEntry {
  readonly id: Id<'LedgerEntry'>;
  readonly courierId: string;
  readonly kind: LedgerEntryKind;
  readonly amount: Money;
  readonly tax: Money;
  readonly reference: string;
  readonly deliveryId?: string;
  readonly payoutLineId?: string;
  readonly reversesEntryId?: Id<'LedgerEntry'>;
  readonly reason?: AdjustmentReason | ReversalReason;
  /** When the fact happened (a delivery, a run's cutoff); runs include entries before their cutoff. */
  readonly occurredAt: Temporal.Instant;
  /** When Drive recorded it, from the Clock. */
  readonly recordedAt: Temporal.Instant;
}

/** A courier's balance: what Drive owes, before tax and the tax on it. Negative when overpaid. */
export interface Balance {
  readonly amount: Money;
  readonly tax: Money;
  readonly total: Money;
}

interface EntryBase {
  readonly id: Id<'LedgerEntry'>;
  readonly courierId: string;
  readonly occurredAt: Temporal.Instant;
  readonly recordedAt: Temporal.Instant;
}

const sign = (value: Money): -1 | 0 | 1 => (value.amount < 0n ? -1 : value.amount > 0n ? 1 : 0);

function checked(entry: LedgerEntry): LedgerEntry {
  if (entry.amount.currency !== entry.tax.currency) {
    throw new PayoutsDomainError('ledger.currency-mismatch', 'Amount and tax differ in currency');
  }
  if (sign(entry.tax) !== 0 && sign(entry.tax) !== sign(entry.amount)) {
    throw new PayoutsDomainError('ledger.tax-sign', 'The tax has the sign of its amount');
  }
  if (entry.courierId.length === 0 || entry.courierId.length > 64) {
    throw new PayoutsDomainError('ledger.invalid-courier', 'A courier id is 1 to 64 characters');
  }
  return Object.freeze(entry);
}

function requirePositive(value: Money, code: string, what: string): void {
  if (value.amount <= 0n) throw new PayoutsDomainError(code, `${what} must be more than zero`);
}

/** The earning of one delivery; one per delivery (`earning:<deliveryId>`). */
export function earningEntry(
  base: EntryBase & { readonly deliveryId: string; readonly amount: Money; readonly tax: Money },
): LedgerEntry {
  requirePositive(base.amount, 'ledger.invalid-amount', 'An earning');
  return checked({ ...base, kind: 'earning', reference: `earning:${base.deliveryId}` });
}

/** A tip on one delivery; one per delivery (`tip:<deliveryId>`). */
export function tipEntry(
  base: EntryBase & { readonly deliveryId: string; readonly amount: Money; readonly tax: Money },
): LedgerEntry {
  requirePositive(base.amount, 'ledger.invalid-amount', 'A tip');
  return checked({ ...base, kind: 'tip', reference: `tip:${base.deliveryId}` });
}

/** An operator's credit or debit; `key` is the caller's idempotency key (`adjustment:<key>`). */
export function adjustmentEntry(
  base: EntryBase & {
    readonly key: string;
    readonly amount: Money;
    readonly tax: Money;
    readonly reason: AdjustmentReason;
  },
): LedgerEntry {
  if (base.amount.amount === 0n) {
    throw new PayoutsDomainError('ledger.invalid-amount', 'An adjustment is never zero');
  }
  const { key, ...entry } = base;
  return checked({ ...entry, kind: 'adjustment', reference: `adjustment:${key}` });
}

/** The debit of one payout line: what the run pays, before tax and the tax (`payout:<lineId>`). */
export function payoutEntry(
  base: EntryBase & { readonly payoutLineId: string; readonly paid: Balance },
): LedgerEntry {
  requirePositive(base.paid.total, 'ledger.invalid-amount', 'A payout');
  const { paid, ...entry } = base;
  const zero = money(0n, paid.amount.currency);
  return checked({
    ...entry,
    kind: 'payout',
    amount: subtractMoney(zero, paid.amount),
    tax: subtractMoney(zero, paid.tax),
    reference: `payout:${base.payoutLineId}`,
  });
}

/**
 * Undoes `entry`, wholly or (with `portion`, a positive share of its total) in part. The reversal
 * carries the opposite sign, the same courier and links, and the share of the tax that belongs to
 * the portion. `reference` is the caller's idempotency key; a reversal is never reversed.
 */
export function reversalOf(
  entry: LedgerEntry,
  base: Omit<EntryBase, 'courierId'> & {
    readonly reference: string;
    readonly reason: ReversalReason;
    readonly portion?: Money;
  },
): LedgerEntry {
  if (entry.kind === 'reversal') {
    throw new PayoutsDomainError('ledger.reversal-of-reversal', 'A reversal is never reversed');
  }
  const total = addMoney(entry.amount, entry.tax);
  let amount = entry.amount;
  let tax = entry.tax;
  if (base.portion !== undefined) {
    const whole = total.amount < 0n ? -total.amount : total.amount;
    if (base.portion.amount <= 0n || base.portion.amount > whole) {
      throw new PayoutsDomainError(
        'ledger.invalid-portion',
        'A partial reversal is more than zero and at most the entry',
      );
    }
    const signed = total.amount < 0n ? -base.portion.amount : base.portion.amount;
    // The tax share is rounded toward zero, so the reversal never undoes more tax than was paid.
    tax = money((entry.tax.amount * signed) / total.amount, total.currency);
    amount = money(signed - tax.amount, total.currency);
  }
  const zero = money(0n, total.currency);
  return checked({
    id: base.id,
    courierId: entry.courierId,
    kind: 'reversal',
    amount: subtractMoney(zero, amount),
    tax: subtractMoney(zero, tax),
    reference: base.reference,
    ...(entry.deliveryId === undefined ? {} : { deliveryId: entry.deliveryId }),
    ...(entry.payoutLineId === undefined ? {} : { payoutLineId: entry.payoutLineId }),
    reversesEntryId: entry.id,
    reason: base.reason,
    occurredAt: base.occurredAt,
    recordedAt: base.recordedAt,
  });
}

/** The balance of `entries`, all in `currency`: the sum of amounts, of taxes, and of both. */
export function balanceOf(entries: readonly LedgerEntry[], currency: string): Balance {
  let amount = money(0n, currency);
  let tax = money(0n, currency);
  for (const entry of entries) {
    amount = addMoney(amount, entry.amount);
    tax = addMoney(tax, entry.tax);
  }
  return { amount, tax, total: addMoney(amount, tax) };
}
