import { numberFormat } from '../shared/intl.ts';
import type { MoneyBody } from './types.ts';

/**
 * Digits after the decimal point in a currency (2 for AUD, 0 for JPY). They belong to the
 * currency (ISO 4217), not to a locale, so the root locale is used.
 */
export function exponentOf(currency: string): number {
  return numberFormat('und', { style: 'currency', currency }).resolvedOptions()
    .maximumFractionDigits as number;
}

/**
 * Minor units as a currency amount in the Market's locale, e.g. "995" and AUD as "$9.95". Exact
 * for any amount the API sends: the integer and fraction parts are split as text, never divided
 * as a float. A malformed amount shows as a dash.
 */
export function formatMoney(value: MoneyBody, locale: string): string {
  const match = /^(-?)(\d{1,18})$/.exec(value.amount);
  if (match === null) return '-';
  const exponent = exponentOf(value.currency);
  const digits = (match[2] as string).padStart(exponent + 1, '0');
  const major =
    exponent === 0 ? digits : `${digits.slice(0, -exponent)}.${digits.slice(-exponent)}`;
  // Intl formats a decimal string exactly (no float rounding) in Node 24 and current browsers.
  return numberFormat(locale, { style: 'currency', currency: value.currency }).format(
    `${match[1] as string}${major}` as `${number}`,
  );
}
