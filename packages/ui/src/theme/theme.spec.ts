import { describe, expect, it } from 'vitest';
import { themeChoice } from './theme.ts';

describe('themeChoice', () => {
  it('keeps light and dark and follows the system for anything else', () => {
    expect(themeChoice('light')).toBe('light');
    expect(themeChoice('dark')).toBe('dark');
    expect(themeChoice(undefined)).toBe('system');
    expect(themeChoice('system')).toBe('system');
    expect(themeChoice('blue')).toBe('system');
  });
});
