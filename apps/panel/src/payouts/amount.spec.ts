import { describe, expect, it } from 'vitest';
import { toMinorUnits } from './amount.ts';

describe('adjustment amount', () => {
  it('turns AUD dollars into cents, as text', () => {
    expect(toMinorUnits('12.5', 'AUD', 'credit')).toBe('1250');
    expect(toMinorUnits('12.05', 'AUD', 'credit')).toBe('1205');
    expect(toMinorUnits(' 0.01 ', 'AUD', 'debit')).toBe('-1');
    expect(toMinorUnits('9999999999999.99', 'AUD', 'credit')).toBe('999999999999999');
  });

  it('takes whole yen for ZZ (JPY has no minor digits)', () => {
    expect(toMinorUnits('1200', 'JPY', 'credit')).toBe('1200');
    expect(toMinorUnits('0050', 'JPY', 'debit')).toBe('-50');
    expect(toMinorUnits('12.5', 'JPY', 'credit')).toBeNull();
  });

  it('refuses zero, a sign, too many digits after the point and text', () => {
    for (const bad of ['0', '0.00', '-5', '+5', '1.234', '1,000', 'ten', '', '.5', '1.']) {
      expect(toMinorUnits(bad, 'AUD', 'credit'), bad).toBeNull();
    }
  });
});
