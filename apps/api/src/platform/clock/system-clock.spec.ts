import { Temporal } from '@mondapac-drive/shared-kernel';
import { SystemClock } from './system-clock';

describe('SystemClock', () => {
  it('returns the current instant, truncated to the millisecond', () => {
    const clock = new SystemClock();

    // The wall clock is read here only to bound the result: platform/clock/ is the one
    // place allowed to read it.
    const before = Date.now();
    const now = clock.now();
    const after = Date.now();

    expect(now).toBeInstanceOf(Temporal.Instant);
    expect(now.epochMilliseconds).toBeGreaterThanOrEqual(before);
    expect(now.epochMilliseconds).toBeLessThanOrEqual(after);
    expect(now.epochNanoseconds % 1_000_000n).toBe(0n);
  });

  it('has no zone: the instant is the same value in every time zone', () => {
    const now = new SystemClock().now();

    expect(Temporal.Instant.from(now.toString())).toEqual(now);
    expect(now.toString()).toMatch(/Z$/);
  });
});
