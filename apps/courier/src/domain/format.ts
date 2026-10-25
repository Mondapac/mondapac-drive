import type { Money } from '../api/schemas';

/**
 * An amount in minor units, formatted for the Market's locale. The number of minor digits comes
 * from the currency (2 for most, 0 for some), never from the app.
 */
export function formatMoney(money: Money, locale: string): string {
  const format = new Intl.NumberFormat(locale, { style: 'currency', currency: money.currency });
  const digits = format.resolvedOptions().maximumFractionDigits ?? 2;
  const minor = BigInt(money.amount);
  const negative = minor < 0n;
  const absolute = negative ? -minor : minor;
  const scale = 10n ** BigInt(digits);
  const whole = absolute / scale;
  const fraction = absolute % scale;
  // Formatted from text so that large amounts keep every digit.
  const text = digits === 0 ? `${whole}` : `${whole}.${fraction.toString().padStart(digits, '0')}`;
  return format.format(Number(`${negative ? '-' : ''}${text}`));
}

export function formatDistance(metres: number, unit: 'km' | 'mi', locale: string): string {
  const value = unit === 'km' ? metres / 1000 : metres / 1609.344;
  const format = new Intl.NumberFormat(locale, {
    style: 'unit',
    unit: unit === 'km' ? 'kilometer' : 'mile',
    maximumFractionDigits: 1,
  });
  return format.format(value);
}

/** An amount and the tax on it, as one figure; both carry the same currency and sign. */
export function withTax(amount: Money, tax: Money): Money {
  return {
    amount: (BigInt(amount.amount) + BigInt(tax.amount)).toString(),
    currency: amount.currency,
  };
}

/** True for an amount of zero, whatever its currency. */
export function isZero(money: Money): boolean {
  return BigInt(money.amount) === 0n;
}

/** A moment from the API (ISO 8601) as the Market's locale writes a date and time. */
export function formatDateTime(instant: string, locale: string): string {
  const ms = Date.parse(instant);
  if (Number.isNaN(ms)) return '';
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(ms);
}
