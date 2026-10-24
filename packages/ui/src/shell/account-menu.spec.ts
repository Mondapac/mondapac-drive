import { describe, expect, it } from 'vitest';
import { initials } from './account-menu.tsx';

describe('initials', () => {
  it('takes the first and last word', () => {
    expect(initials('Cody James Fisher')).toBe('CF');
  });

  it('takes one letter of a one-word name', () => {
    expect(initials('  ada ')).toBe('A');
  });

  it('keeps a whole character outside the basic plane', () => {
    expect(initials('𝒜da Lovelace')).toBe('𝒜L');
  });

  it('gives nothing for an empty name', () => {
    expect(initials('   ')).toBe('');
  });
});
