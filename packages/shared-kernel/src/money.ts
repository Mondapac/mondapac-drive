/**
 * Money is always an integer amount of minor units plus an ISO 4217 currency code, as in the
 * marketplace (ADR-0007 there). Never a float, never an assumed currency.
 */
export interface Money {
  readonly amount: number;
  readonly currency: string;
}

export function money(amount: number, currency: string): Money {
  if (!Number.isSafeInteger(amount)) {
    throw new RangeError(`Money amount must be an integer number of minor units, got ${amount}`);
  }
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new RangeError(`Currency must be an ISO 4217 code, got "${currency}"`);
  }
  return { amount, currency };
}

export function addMoney(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.amount + b.amount, a.currency);
}

/** Multiplies by a rate given in basis points (10000 = 1x), rounding half away from zero. */
export function scaleMoney(value: Money, basisPoints: number): Money {
  return money(roundHalfAwayFromZero((value.amount * basisPoints) / 10_000), value.currency);
}

function roundHalfAwayFromZero(n: number): number {
  return Math.sign(n) * Math.round(Math.abs(n));
}

function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new RangeError(`Cannot combine ${a.currency} with ${b.currency}`);
  }
}
