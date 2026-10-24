import { err, ok } from './result';
import type { Result } from './result';

/**
 * Money (ADR-0007 decision 1): an integer amount of minor units and an ISO 4217 currency. No
 * floating point anywhere; the minor-unit exponent comes from the currency (JPY 0, AUD 2,
 * KWD 3), never an assumed 2. Arithmetic across currencies throws: there is no conversion in
 * the kernel. Values are immutable, so `===` on `amount` and `currency` is equality.
 */
export interface Money {
  readonly amount: bigint;
  readonly currency: string;
}

/** A programmer error: a malformed currency, a cross-currency operation, a bad ratio or weight. */
export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoneyError';
  }
}

/** Why `parseMoney` refused its input. Never holds the value. */
export type MoneyParseError =
  { readonly code: 'money.invalid-amount' } | { readonly code: 'money.invalid-currency' };

/** How a ratio that does not divide evenly is rounded. Always stated by the caller or `half-up`. */
export type RoundingMode = 'half-up' | 'half-even' | 'down' | 'up';

const CURRENCY_SHAPE = /^[A-Z]{3}$/;
const exponents = new Map<string, number>();
// `Intl.NumberFormat` accepts any well-formed code and answers 2 for an unknown one, so a typo
// would pass silently. The platform's own list of ISO 4217 codes is the gate.
// ISO 4217 minor-unit digits for every currency that is not 2, checked in so the exponent never
// depends on the runtime's ICU data (CLDR differs from ISO for IQD, MGA and others).
const ISO_4217_EXPONENT: ReadonlyMap<string, number> = new Map([
  ...[
    'BIF',
    'CLP',
    'DJF',
    'GNF',
    'ISK',
    'JPY',
    'KMF',
    'KRW',
    'PYG',
    'RWF',
    'UGX',
    'UYI',
    'VND',
    'VUV',
    'XAF',
    'XOF',
    'XPF',
  ].map((code): [string, number] => [code, 0]),
  ...['BHD', 'IQD', 'JOD', 'KWD', 'LYD', 'OMR', 'TND'].map((code): [string, number] => [code, 3]),
  ...['CLF', 'UYW'].map((code): [string, number] => [code, 4]),
]);
let knownCurrencies: ReadonlySet<string> | undefined;

/**
 * The number of minor-unit digits of a currency, from the platform's ISO 4217 data. Throws
 * `MoneyError` for a code that is not a well-formed, known currency.
 */
export function minorUnitExponent(currency: string): number {
  const known = exponents.get(currency);
  if (known !== undefined) return known;
  if (typeof currency !== 'string' || !CURRENCY_SHAPE.test(currency)) {
    throw new MoneyError('currency must be an upper-case ISO 4217 code');
  }
  knownCurrencies ??= new Set(Intl.supportedValuesOf('currency'));
  if (!knownCurrencies.has(currency) && !ISO_4217_EXPONENT.has(currency)) {
    throw new MoneyError('currency must be an upper-case ISO 4217 code');
  }
  const digits = ISO_4217_EXPONENT.get(currency) ?? 2;
  exponents.set(currency, digits);
  return digits;
}

/** Builds a Money from values the code already trusts. Throws `MoneyError` on a bad currency. */
export function money(amount: bigint, currency: string): Money {
  if (typeof amount !== 'bigint') throw new MoneyError('amount must be a bigint');
  minorUnitExponent(currency);
  return Object.freeze({ amount, currency });
}

/** Builds a Money from untrusted input: the amount must be a bigint, the currency well formed. */
export function parseMoney(amount: unknown, currency: unknown): Result<Money, MoneyParseError> {
  if (typeof currency !== 'string' || !CURRENCY_SHAPE.test(currency)) {
    return err({ code: 'money.invalid-currency' });
  }
  try {
    minorUnitExponent(currency);
  } catch {
    return err({ code: 'money.invalid-currency' });
  }
  if (typeof amount !== 'bigint') return err({ code: 'money.invalid-amount' });
  return ok(Object.freeze({ amount, currency }));
}

/** The most digits of a wire amount: below 2^53 and inside a BIGINT column (pricing design 4.4). */
export const MAX_WIRE_AMOUNT_DIGITS = 16;

/**
 * Parses an amount sent as a string of minor units (ADR-0007 decision 10): digits only, no
 * sign, no space, no leading zero (except `0` itself), at most `maxDigits` (default 16). The
 * one place a wire amount becomes a bigint, so no caller reaches for the lenient `BigInt(text)`.
 */
export function parseMinorUnits(
  text: unknown,
  maxDigits: number = MAX_WIRE_AMOUNT_DIGITS,
): Result<bigint, { readonly code: 'money.invalid-amount' }> {
  if (typeof text !== 'string' || !/^(0|[1-9][0-9]*)$/.test(text) || text.length > maxDigits) {
    return err({ code: 'money.invalid-amount' });
  }
  return ok(BigInt(text));
}

function sameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new MoneyError('money in different currencies cannot be combined');
  }
}

export function addMoney(a: Money, b: Money): Money {
  sameCurrency(a, b);
  return Object.freeze({ amount: a.amount + b.amount, currency: a.currency });
}

export function subtractMoney(a: Money, b: Money): Money {
  sameCurrency(a, b);
  return Object.freeze({ amount: a.amount - b.amount, currency: a.currency });
}

export function compareMoney(a: Money, b: Money): -1 | 0 | 1 {
  sameCurrency(a, b);
  if (a.amount === b.amount) return 0;
  return a.amount < b.amount ? -1 : 1;
}

/** `value / divisor` rounded as `mode` says; `down` and `up` are toward and away from zero. */
function divideRounded(value: bigint, divisor: bigint, mode: RoundingMode): bigint {
  const negative = value < 0n;
  const magnitude = negative ? -value : value;
  const quotient = magnitude / divisor;
  const remainder = magnitude % divisor;
  let rounded = quotient;
  if (remainder !== 0n) {
    const twice = remainder * 2n;
    switch (mode) {
      case 'down':
        break;
      case 'up':
        rounded = quotient + 1n;
        break;
      case 'half-up':
        if (twice >= divisor) rounded = quotient + 1n;
        break;
      case 'half-even':
        if (twice > divisor || (twice === divisor && quotient % 2n === 1n)) rounded = quotient + 1n;
        break;
    }
  }
  return negative ? -rounded : rounded;
}

/**
 * `money x numerator / denominator` with the rounding stated (default half-up, away from zero
 * for a negative amount; ADR-0007 decision 2). A rate is an exact ratio of integers, never a
 * float; `down` and `up` are toward and away from zero.
 */
export function scaleMoney(
  value: Money,
  numerator: bigint,
  denominator: bigint,
  mode: RoundingMode = 'half-up',
): Money {
  if (denominator <= 0n) throw new MoneyError('denominator must be positive');
  if (numerator < 0n) throw new MoneyError('numerator must not be negative');
  return Object.freeze({
    amount: divideRounded(value.amount * numerator, denominator, mode),
    currency: value.currency,
  });
}

/**
 * Splits `whole` by `weights` with largest-remainder allocation (ADR-0007 decision 1), so the
 * parts always sum exactly to the whole. Leftover minor units go to the largest remainders, a
 * tie to the earlier part. Weights are non-negative and not all zero.
 */
export function allocateMoney(whole: Money, weights: readonly bigint[]): Money[] {
  if (weights.length === 0) throw new MoneyError('at least one weight is required');
  if (weights.some((weight) => weight < 0n)) throw new MoneyError('weights must not be negative');
  const total = weights.reduce((sum, weight) => sum + weight, 0n);
  if (total === 0n) throw new MoneyError('weights must not all be zero');

  const negative = whole.amount < 0n;
  const magnitude = negative ? -whole.amount : whole.amount;
  const shares = weights.map((weight) => (magnitude * weight) / total);
  const remainders = weights.map((weight, index) => ({
    index,
    remainder: (magnitude * weight) % total,
  }));
  let left = magnitude - shares.reduce((sum, share) => sum + share, 0n);
  remainders.sort((a, b) =>
    a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1,
  );
  for (const { index } of remainders) {
    if (left === 0n) break;
    shares[index] = (shares[index] ?? 0n) + 1n;
    left -= 1n;
  }
  return shares.map((share) =>
    Object.freeze({ amount: negative ? -share : share, currency: whole.currency }),
  );
}
