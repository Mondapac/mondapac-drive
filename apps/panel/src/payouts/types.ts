// The payouts screens' shapes (Drive, handoff 24b). Amounts are minor units as decimal text with
// an ISO 4217 currency; a payout line never carries the courier's bank or payout account.

import type { MoneyBody } from '../ops/types.ts';

export const LINE_STATUSES = [
  'pending',
  'held',
  'transferred',
  'failed',
  'unresolved',
  'reversed',
] as const;
export type LineStatus = (typeof LINE_STATUSES)[number];

export const ADJUSTMENT_REASONS = ['bonus', 'correction', 'damage-claim', 'other'] as const;
export type AdjustmentReason = (typeof ADJUSTMENT_REASONS)[number];

export interface PayoutLine {
  readonly id: string;
  readonly runId: string;
  readonly courierId: string;
  readonly amount: MoneyBody;
  readonly tax: MoneyBody;
  readonly status: LineStatus;
  readonly holdReason?: string;
  readonly transferId?: string;
  readonly attempts: number;
  readonly lastErrorCode?: string;
  readonly reversedAmount: MoneyBody;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface LinePage {
  readonly lines: readonly PayoutLine[];
  readonly next?: string;
}

export interface LedgerEntry {
  readonly id: string;
  readonly kind: 'earning' | 'tip' | 'adjustment' | 'reversal' | 'payout';
  readonly amount: MoneyBody;
  readonly tax: MoneyBody;
  readonly deliveryId?: string;
  readonly payoutLineId?: string;
  readonly reason?: string;
  readonly occurredAt: string;
}

export interface CourierBalance {
  readonly balance: {
    readonly amount: MoneyBody;
    readonly tax: MoneyBody;
    readonly total: MoneyBody;
  };
  readonly entries: readonly LedgerEntry[];
}

/** The lines screen's tabs and the statuses each asks for. */
export const LINE_FILTERS = {
  attention: ['held', 'unresolved'],
  held: ['held'],
  unresolved: ['unresolved'],
  failed: ['failed', 'reversed'],
  transferred: ['transferred'],
} as const satisfies Record<string, readonly LineStatus[]>;
export type LineFilter = keyof typeof LINE_FILTERS;

export const PAYOUT_PERMISSION = {
  ledgerView: 'payouts.ledger.view',
  adjustmentRecord: 'payouts.adjustment.record',
  lineSettle: 'payouts.line.settle',
} as const;
