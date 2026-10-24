import { describe, expect, it } from 'vitest';
import { exponentOf, formatMoney } from '../ops/money.ts';
import { formatInstant, formatInstantInZone, shortInstant } from './format.ts';
import { dateFormat, numberFormat } from './intl.ts';

// The two Market fixtures (CLAUDE.md): AU, and the synthetic ZZ (en-ZZ, JPY: no minor digits).
const AU = { locale: 'en-AU', currency: 'AUD' };
const ZZ = { locale: 'en-ZZ', currency: 'JPY' };

describe('formats follow the Market locale', () => {
  it('formats an instant in UTC under each locale', () => {
    for (const { locale } of [AU, ZZ]) {
      expect(formatInstant('2026-10-09T23:30:00.000Z', locale)).toMatch(/2026.*UTC$/);
    }
    expect(formatInstant('2026-10-09T23:30:00.000Z', AU.locale)).toMatch(
      /^9 Oct 2026, 11:30\s?pm UTC$/i,
    );
  });

  it('keeps the dash for a missing or bad instant in every locale', () => {
    for (const { locale } of [AU, ZZ]) {
      expect(formatInstant(null, locale)).toBe('-');
      expect(formatInstant('nope', locale)).toBe('-');
      expect(shortInstant(null, locale)).toBe('-');
      expect(shortInstant('nope', locale)).toBe('-');
    }
  });

  it('formats minor units exactly in the Market currency', () => {
    expect(formatMoney({ amount: '1999', currency: AU.currency }, AU.locale)).toBe('$19.99');
    expect(formatMoney({ amount: '5', currency: AU.currency }, AU.locale)).toBe('$0.05');
    expect(formatMoney({ amount: '1999', currency: ZZ.currency }, ZZ.locale)).toMatch(/1,999$/);
    expect(formatMoney({ amount: '1999', currency: ZZ.currency }, ZZ.locale)).not.toContain('.');
    // Beyond 2^53: the digits are kept, never rounded through a float.
    expect(formatMoney({ amount: '900719925474099312', currency: AU.currency }, AU.locale)).toBe(
      '$9,007,199,254,740,993.12',
    );
  });

  it('shows a dash for a malformed amount', () => {
    for (const amount of ['x', '1.5', '', '1e3']) {
      expect(formatMoney({ amount, currency: AU.currency }, AU.locale)).toBe('-');
    }
  });

  it('reads the currency exponent from the currency, not the locale', () => {
    expect(exponentOf(AU.currency)).toBe(2);
    expect(exponentOf(ZZ.currency)).toBe(0);
  });
});

describe('Intl format cache', () => {
  it('reuses a formatter per locale and options', () => {
    const options = { dateStyle: 'medium' } as const;
    expect(dateFormat(AU.locale, options)).toBe(dateFormat(AU.locale, options));
    expect(dateFormat(AU.locale, options)).not.toBe(dateFormat(ZZ.locale, options));
    const money = { style: 'currency', currency: AU.currency } as const;
    expect(numberFormat(AU.locale, money)).toBe(numberFormat(AU.locale, money));
    expect(numberFormat(AU.locale, money)).not.toBe(numberFormat(ZZ.locale, money));
  });
});

describe('formatInstantInZone', () => {
  it('shows the holder zone with its short name, and falls back to UTC for an unknown zone', () => {
    const iso = '2026-10-09T13:30:00Z';
    expect(formatInstantInZone(iso, AU.locale, 'Australia/Brisbane')).toMatch(/11:30\s?pm AEST/i);
    expect(formatInstantInZone(iso, AU.locale, 'Mars/Olympus')).toBe(formatInstant(iso, AU.locale));
    expect(formatInstantInZone(null, AU.locale, 'UTC')).toBe('-');
  });
});
