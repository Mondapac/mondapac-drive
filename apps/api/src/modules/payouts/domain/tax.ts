import { money, scaleMoney, type Money } from '@mondapac-drive/shared-kernel';
import type { Payee } from './payee';
import type { MarketPayoutSettings } from './payout-settings';

const BASIS_POINTS = 10_000n;

/** What a ledger amount is, for tax: pay for a service (earning, adjustment) or a tip. */
export type TaxableKind = 'service' | 'tip';

/**
 * The indirect tax (AU: GST) Drive adds to an amount it owes a contractor: the Market's rate when
 * the contractor is registered for it, nothing otherwise, and nothing on tips unless the Market
 * says so. Pay is stated before tax, so the tax is on top. Rounded half-up; a negative amount (a
 * deduction) carries a negative tax.
 */
export function payTaxOn(
  settings: MarketPayoutSettings,
  payee: Payee,
  kind: TaxableKind,
  amount: Money,
): Money {
  const taxed =
    payee.engagement === 'contractor' &&
    payee.taxRegistered &&
    (kind === 'service' || settings.tax.onTips);
  if (!taxed) return money(0n, amount.currency);
  return scaleMoney(amount, BigInt(settings.tax.rateBps), BASIS_POINTS);
}
