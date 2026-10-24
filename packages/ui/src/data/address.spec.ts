import { describe, expect, it } from 'vitest';
import { addressLines } from './address.ts';

describe('addressLines', () => {
  it('puts the street first and the place with its state and postcode on one line', () => {
    expect(
      addressLines({
        postcode: '4102',
        line1: '12 Logan Road',
        state: 'QLD',
        suburb: 'Woolloongabba',
      }),
    ).toBe('12 Logan Road\nWoolloongabba QLD 4102');
  });

  it('keeps a key it does not know as its own line, after the others', () => {
    expect(addressLines({ line1: '1 Rue X', district: 'Ward 3', city: 'Lyon' })).toBe(
      '1 Rue X\nLyon\nWard 3',
    );
  });

  it('returns null for no address or only blank parts', () => {
    expect(addressLines(null)).toBeNull();
    expect(addressLines({ line1: ' ' })).toBeNull();
  });
});
