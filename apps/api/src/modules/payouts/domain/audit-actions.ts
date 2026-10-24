import { auditField, defineAuditAction } from '@mondapac-drive/shared-kernel';
import { ADJUSTMENT_REASONS } from './ledger';
import { PAYOUT_LINE_STATUSES } from './payout-run';

// The operator actions on courier money that the payouts module audits (platform/audit), each
// with the operator who took it. No field holds a name, an account or a bank detail.

/** An operator credited or debited a courier's balance. Target: the courier. */
export const adjustmentRecorded = defineAuditAction({
  action: 'payouts.adjustment.recorded',
  targetType: 'payouts.courier',
  actors: ['authenticated'],
  after: {
    entryId: auditField.id(),
    amount: auditField.money(),
    tax: auditField.money(),
    reason: auditField.enumOf(ADJUSTMENT_REASONS),
  },
});

/**
 * An operator settled an unresolved payout line against the provider's records: `transferred`
 * when the provider holds its transfer, `failed` (debit reversed) when it holds none. Target:
 * the line.
 */
export const lineSettledAudit = defineAuditAction({
  action: 'payouts.line.settled',
  targetType: 'payouts.line',
  actors: ['authenticated'],
  before: { status: auditField.enumOf(PAYOUT_LINE_STATUSES) },
  after: {
    status: auditField.enumOf(PAYOUT_LINE_STATUSES),
    courierId: auditField.id(),
    providerTransferFound: auditField.boolean(),
  },
});

export const PAYOUTS_AUDIT_ACTIONS = [adjustmentRecorded, lineSettledAudit] as const;
