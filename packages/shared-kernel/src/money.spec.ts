import {
  addMoney,
  MAX_WIRE_AMOUNT_DIGITS,
  parseMinorUnits,
  allocateMoney,
  compareMoney,
  minorUnitExponent,
  money,
  MoneyError,
  parseMoney,
  scaleMoney,
  subtractMoney,
} from './money';

describe('minorUnitExponent', () => {
  it.each([
    ['AUD', 2],
    ['JPY', 0],
    ['KWD', 3],
    ['IQD', 3],
    ['CLF', 4],
    ['MGA', 2],
    ['VND', 0],
    ['USD', 2],
  ])('is read from ISO 4217 for %s', (currency, exponent) => {
    expect(minorUnitExponent(currency)).toBe(exponent);
  });

  it('refuses a code that is not a well-formed currency', () => {
    for (const code of ['aud', 'AU', 'AUDD', '', 'A1D', '12$', 'QQQ', 'AUS', 'ZZZ', 'XXX', 'XTS']) {
      expect(() => minorUnitExponent(code)).toThrow(MoneyError);
    }
  });
});

describe('parseMoney', () => {
  it('accepts a whole number of minor units in a known currency', () => {
    expect(parseMoney(1999n, 'AUD')).toEqual({
      ok: true,
      value: { amount: 1999n, currency: 'AUD' },
    });
    expect(parseMoney(0n, 'JPY').ok).toBe(true);
    expect(parseMoney(-5n, 'AUD').ok).toBe(true);
  });

  it('refuses a number, a fraction and a non-bigint amount', () => {
    for (const amount of [19.99, 1999, '1999', null, undefined, Number.NaN] as unknown[]) {
      expect(parseMoney(amount, 'AUD')).toEqual({
        ok: false,
        error: { code: 'money.invalid-amount' },
      });
    }
  });

  it('refuses a malformed currency code', () => {
    expect(parseMoney(1n, 'aud')).toEqual({ ok: false, error: { code: 'money.invalid-currency' } });
    expect(parseMoney(1n, 5).ok).toBe(false);
  });
});

describe('money', () => {
  it('refuses an amount that is not a bigint', () => {
    expect(() => money(1.5 as unknown as bigint, 'AUD')).toThrow(MoneyError);
    expect(() => money(150 as unknown as bigint, 'AUD')).toThrow(MoneyError);
  });
});

describe('arithmetic', () => {
  const aud = (amount: bigint) => money(amount, 'AUD');
  const jpy = (amount: bigint) => money(amount, 'JPY');

  it('adds and subtracts in the same currency', () => {
    expect(addMoney(aud(150n), aud(275n))).toEqual(aud(425n));
    expect(subtractMoney(aud(150n), aud(275n))).toEqual(aud(-125n));
  });

  it('throws across currencies, never converts', () => {
    expect(() => addMoney(aud(1n), jpy(1n))).toThrow(MoneyError);
    expect(() => subtractMoney(aud(1n), jpy(1n))).toThrow(MoneyError);
    expect(() => compareMoney(aud(1n), jpy(1n))).toThrow(MoneyError);
  });

  it('compares', () => {
    expect(compareMoney(aud(1n), aud(2n))).toBe(-1);
    expect(compareMoney(aud(2n), aud(2n))).toBe(0);
    expect(compareMoney(aud(3n), aud(2n))).toBe(1);
  });

  it('does not use floating point for large amounts', () => {
    const big = 2n ** 80n;
    expect(addMoney(aud(big), aud(1n)).amount).toBe(big + 1n);
  });
});

describe('scaleMoney', () => {
  const aud = (amount: bigint) => money(amount, 'AUD');

  it('applies an exact ratio with half-up rounding by default', () => {
    // 10% of 1.05 = 0.105 -> 0.11 (half-up)
    expect(scaleMoney(aud(105n), 1n, 10n)).toEqual(aud(11n));
    // 10% of 1.04 = 0.104 -> 0.10
    expect(scaleMoney(aud(104n), 1n, 10n)).toEqual(aud(10n));
  });

  it('rounds half-up away from zero for a negative amount', () => {
    expect(scaleMoney(aud(-105n), 1n, 10n)).toEqual(aud(-11n));
  });

  it('states other rounding modes explicitly', () => {
    expect(scaleMoney(aud(105n), 1n, 10n, 'down')).toEqual(aud(10n));
    expect(scaleMoney(aud(101n), 1n, 10n, 'up')).toEqual(aud(11n));
    expect(scaleMoney(aud(105n), 1n, 10n, 'half-even')).toEqual(aud(10n));
    expect(scaleMoney(aud(115n), 1n, 10n, 'half-even')).toEqual(aud(12n));
  });

  it.each([
    // [amount, down, up, half-up, half-even] for amount x 1/10
    [25n, 2n, 3n, 3n, 2n],
    [15n, 1n, 2n, 2n, 2n],
    [11n, 1n, 2n, 1n, 1n],
    [10n, 1n, 1n, 1n, 1n],
    [0n, 0n, 0n, 0n, 0n],
    [-25n, -2n, -3n, -3n, -2n],
    [-15n, -1n, -2n, -2n, -2n],
    [-11n, -1n, -2n, -1n, -1n],
  ])('rounds %s tenths under every mode', (amount, down, up, halfUp, halfEven) => {
    expect(scaleMoney(aud(amount), 1n, 10n, 'down').amount).toBe(down);
    expect(scaleMoney(aud(amount), 1n, 10n, 'up').amount).toBe(up);
    expect(scaleMoney(aud(amount), 1n, 10n, 'half-up').amount).toBe(halfUp);
    expect(scaleMoney(aud(amount), 1n, 10n, 'half-even').amount).toBe(halfEven);
  });

  it('scales in zero- and three-digit currencies and by a zero numerator', () => {
    expect(scaleMoney(money(1000n, 'JPY'), 1n, 11n)).toEqual(money(91n, 'JPY'));
    expect(scaleMoney(money(1000n, 'KWD'), 1n, 3n)).toEqual(money(333n, 'KWD'));
    expect(scaleMoney(aud(500n), 0n, 7n)).toEqual(aud(0n));
    expect(scaleMoney(aud(2n ** 90n), 1n, 2n).amount).toBe(2n ** 89n);
  });

  it('extracts GST from a tax-inclusive price (ADR-0007 decision 4)', () => {
    // 110 incl. GST at 10%: 110 * 1 / 11 = 10
    expect(scaleMoney(aud(11000n), 1n, 11n)).toEqual(aud(1000n));
  });

  it('refuses a non-positive denominator and a negative numerator', () => {
    expect(() => scaleMoney(aud(1n), 1n, 0n)).toThrow(MoneyError);
    expect(() => scaleMoney(aud(1n), 1n, -1n)).toThrow(MoneyError);
    expect(() => scaleMoney(aud(1n), -1n, 1n)).toThrow(MoneyError);
  });
});

describe('allocateMoney (largest remainder)', () => {
  const aud = (amount: bigint) => money(amount, 'AUD');
  const sum = (parts: readonly { amount: bigint }[]) => parts.reduce((s, p) => s + p.amount, 0n);

  it('splits so the parts always sum to the whole', () => {
    const parts = allocateMoney(aud(100n), [1n, 1n, 1n]);
    expect(parts.map((p) => p.amount)).toEqual([34n, 33n, 33n]);
    expect(sum(parts)).toBe(100n);
  });

  it('gives the leftover units to the largest remainders, ties to the earlier part', () => {
    expect(allocateMoney(aud(5n), [3n, 7n]).map((p) => p.amount)).toEqual([2n, 3n]);
    expect(allocateMoney(aud(10n), [1n, 1n, 1n, 1n, 1n, 1n, 1n]).map((p) => p.amount)).toEqual([
      2n,
      2n,
      2n,
      1n,
      1n,
      1n,
      1n,
    ]);
  });

  it('keeps the currency and handles a zero weight and a negative whole', () => {
    expect(allocateMoney(aud(10n), [0n, 1n]).map((p) => p.amount)).toEqual([0n, 10n]);
    const negative = allocateMoney(aud(-100n), [1n, 1n, 1n]);
    expect(sum(negative)).toBe(-100n);
    expect(negative.every((p) => p.currency === 'AUD')).toBe(true);
  });

  it('allocates a single part, a zero whole and in a zero-digit currency', () => {
    expect(allocateMoney(aud(7n), [5n])).toEqual([aud(7n)]);
    expect(allocateMoney(aud(0n), [1n, 2n])).toEqual([aud(0n), aud(0n)]);
    expect(allocateMoney(money(10n, 'JPY'), [1n, 1n, 1n]).map((p) => p.amount)).toEqual([
      4n,
      3n,
      3n,
    ]);
  });

  it('refuses no parts, a negative weight and all-zero weights', () => {
    expect(() => allocateMoney(aud(1n), [])).toThrow(MoneyError);
    expect(() => allocateMoney(aud(1n), [1n, -1n])).toThrow(MoneyError);
    expect(() => allocateMoney(aud(1n), [0n, 0n])).toThrow(MoneyError);
  });
});

describe('parseMinorUnits', () => {
  it('accepts digits only, up to 16, with no leading zero', () => {
    expect(parseMinorUnits('0')).toEqual({ ok: true, value: 0n });
    expect(parseMinorUnits('1999')).toEqual({ ok: true, value: 1999n });
    const longest = '9'.repeat(MAX_WIRE_AMOUNT_DIGITS);
    expect(parseMinorUnits(longest)).toEqual({ ok: true, value: BigInt(longest) });
  });

  it.each(['', ' 1', '1 ', '0x1', '0b1', '+1', '-1', '01', '1.5', '1e3', '１２', '9'.repeat(17)])(
    'refuses %j',
    (text) => {
      expect(parseMinorUnits(text)).toEqual({ ok: false, error: { code: 'money.invalid-amount' } });
    },
  );

  it('refuses a non-string and honours a lower digit limit', () => {
    expect(parseMinorUnits(5).ok).toBe(false);
    expect(parseMinorUnits(null).ok).toBe(false);
    expect(parseMinorUnits('1234', 3).ok).toBe(false);
  });
});

describe('immutability', () => {
  it('freezes every value the module builds', () => {
    const a = money(1n, 'AUD');
    expect(Object.isFrozen(a)).toBe(true);
    expect(Object.isFrozen(addMoney(a, a))).toBe(true);
    expect(Object.isFrozen(subtractMoney(a, a))).toBe(true);
    expect(Object.isFrozen(scaleMoney(a, 1n, 2n))).toBe(true);
    expect(allocateMoney(a, [1n]).every((part) => Object.isFrozen(part))).toBe(true);
  });
});
