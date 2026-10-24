import { HttpException } from '@nestjs/common';
import type { Money, Result } from '@mondapac-drive/shared-kernel';
import { ZodError } from 'zod';
import type { LedgerEntry } from '../domain/ledger';
import type { PayoutLine } from '../domain/payout-run';

/** The status of each refusal; any other code is a broken domain rule (422). */
const STATUS: Readonly<Record<string, number>> = Object.freeze({
  'payouts.unknown-courier': 404,
  'payouts.line-not-found': 404,
  'payouts.line-state': 409,
  'payouts.key-reused': 409,
  'payouts.settle-ambiguous': 409,
  'payouts.settle-mismatch': 409,
  'payouts.not-a-contractor': 409,
  'payouts.provider-unavailable': 503,
  'payouts.provider-refused': 502,
  'access.unauthenticated': 401,
  'access.denied': 403,
  'access.unavailable': 503,
});

interface Refusal {
  readonly code: string;
  readonly message?: string;
}

export function fail(status: number, code: string, details?: object): HttpException {
  return new HttpException({ statusCode: status, code, ...(details ? { details } : {}) }, status);
}

/** Parses a body or query with zod; a refusal names the fields and issues, never the values. */
export function parsed<T>(parse: () => T): T {
  try {
    return parse();
  } catch (error) {
    if (error instanceof ZodError) {
      throw fail(400, 'validation.failed', {
        fields: error.issues
          .slice(0, 10)
          .map((issue) => ({ path: issue.path.join('.'), code: issue.code })),
      });
    }
    throw error;
  }
}

export function answer<T>(result: Result<T, Refusal>): T {
  if (result.ok) return result.value;
  const { code, message } = result.error;
  throw fail(STATUS[code] ?? 422, code, message === undefined ? undefined : { message });
}

/** Money on the wire: minor units as decimal text (a JPY or AUD amount fits no float safely). */
export const moneyBody = (value: Money) => ({
  amount: value.amount.toString(),
  currency: value.currency,
});

export const entryBody = (entry: LedgerEntry) => ({
  id: entry.id,
  kind: entry.kind,
  amount: moneyBody(entry.amount),
  tax: moneyBody(entry.tax),
  ...(entry.deliveryId === undefined ? {} : { deliveryId: entry.deliveryId }),
  ...(entry.payoutLineId === undefined ? {} : { payoutLineId: entry.payoutLineId }),
  ...(entry.reason === undefined ? {} : { reason: entry.reason }),
  occurredAt: entry.occurredAt.toString(),
});

/** A line for operators: never the provider's account id (`destination`). */
export const lineBody = (line: PayoutLine) => ({
  id: line.id,
  runId: line.runId,
  courierId: line.courierId,
  amount: moneyBody(line.amount),
  tax: moneyBody(line.tax),
  status: line.status,
  ...(line.holdReason === undefined ? {} : { holdReason: line.holdReason }),
  ...(line.transferId === undefined ? {} : { transferId: line.transferId }),
  attempts: line.attempts,
  ...(line.lastErrorCode === undefined ? {} : { lastErrorCode: line.lastErrorCode }),
  reversedAmount: moneyBody(line.reversedAmount),
  createdAt: line.createdAt.toString(),
  updatedAt: line.updatedAt.toString(),
});
