import { declarePermissions, definePermission } from '../../../platform/authz';

// The permission catalogue of payouts, pushed into the permission registry at bootstrap. A
// courier acts through the courier system role, which holds every courier key; operators through
// the platform roles that name the platform keys. Moving money is protected: only the Platform
// Administrator, or a custom role it grants, may record an adjustment or settle a line.

/** See one's own earnings, balance and ledger in the courier app. */
export const EARNINGS_VIEW = definePermission('payouts', {
  key: 'payouts.earnings.view',
  scope: 'courier',
  protected: false,
});

/** Open the payment provider's onboarding of one's own payout account. */
export const ACCOUNT_ONBOARD = definePermission('payouts', {
  key: 'payouts.account.onboard',
  scope: 'courier',
  protected: false,
});

/** See couriers' balances and the payout lines of every run (held, unresolved, failed, ...). */
export const LEDGER_VIEW = definePermission('payouts', {
  key: 'payouts.ledger.view',
  scope: 'platform',
  protected: false,
});

/** Credit or debit a courier's balance. */
export const ADJUSTMENT_RECORD = definePermission('payouts', {
  key: 'payouts.adjustment.record',
  scope: 'platform',
  protected: true,
});

/** Settle an unresolved payout line against the provider's records. */
export const LINE_SETTLE = definePermission('payouts', {
  key: 'payouts.line.settle',
  scope: 'platform',
  protected: true,
});

/** Every permission payouts declares, for its module's registration. */
export const PAYOUTS_PERMISSIONS = declarePermissions('payouts', [
  EARNINGS_VIEW,
  ACCOUNT_ONBOARD,
  LEDGER_VIEW,
  ADJUSTMENT_RECORD,
  LINE_SETTLE,
]);
