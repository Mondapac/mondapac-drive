import { exponentOf } from '../ops/money.ts';

/**
 * An amount the operator typed in major units ("12.50" for AUD, "1200" for JPY) as minor units
 * in decimal text, signed by `direction`. Parsed as text, never as a float; null for anything
 * that is not a positive amount with at most the currency's digits after the point.
 */
export function toMinorUnits(
  text: string,
  currency: string,
  direction: 'credit' | 'debit',
): string | null {
  const exponent = exponentOf(currency);
  const pattern =
    exponent === 0 ? /^(\d{1,13})$/ : new RegExp(`^(\\d{1,13})(?:\\.(\\d{1,${exponent}}))?$`);
  const match = pattern.exec(text.trim());
  if (match === null) return null;
  const digits = `${match[1] as string}${(match[2] ?? '').padEnd(exponent, '0')}`.replace(
    /^0+(?=\d)/,
    '',
  );
  if (digits === '0') return null;
  return direction === 'debit' ? `-${digits}` : digits;
}
