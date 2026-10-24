import { StreamLimits } from './stream-limits';

describe('tracking stream limits', () => {
  it('holds a token to its limit and gives the slot back once, on release', () => {
    const limits = new StreamLimits(2, 10);
    const first = limits.acquire('t')!;
    limits.acquire('t');
    expect(limits.acquire('t')).toBeUndefined();
    expect(limits.acquire('other')).toBeDefined();
    first();
    first();
    expect(limits.open).toBe(2);
    expect(limits.acquire('t')).toBeDefined();
  });

  it('holds the instance to its total', () => {
    const limits = new StreamLimits(5, 2);
    limits.acquire('a');
    limits.acquire('b');
    expect(limits.acquire('c')).toBeUndefined();
  });
});
