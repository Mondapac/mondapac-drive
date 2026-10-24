import { isMinted, parseId, Temporal, uuidV7 } from './index';
import type { Clock, IdGenerator, MarketContext } from './index';
import { FixedClock, SequenceIdGenerator, testMarketContext } from './testing';

const START = Temporal.Instant.from('2026-10-03T16:00:00.123Z');

describe('FixedClock', () => {
  it('returns the start instant until it is told otherwise', () => {
    const clock: Clock = new FixedClock(START);

    expect(clock.now().equals(START)).toBe(true);
    expect(clock.now().equals(START)).toBe(true);
    expect(clock.now().toString()).toBe('2026-10-03T16:00:00.123Z');
  });

  it('moves forward only on advance()', () => {
    const clock = new FixedClock(START);

    clock.advance(Temporal.Duration.from({ minutes: 60 }));
    expect(clock.now().toString()).toBe('2026-10-03T17:00:00.123Z');

    clock.advance(Temporal.Duration.from({ milliseconds: 1 }));
    expect(clock.now().toString()).toBe('2026-10-03T17:00:00.124Z');
    expect(clock.now().toString()).toBe('2026-10-03T17:00:00.124Z');
  });

  it('jumps to an instant on set(), also backwards', () => {
    const clock = new FixedClock(START);

    clock.set(Temporal.Instant.from('2030-01-01T00:00:00Z'));
    expect(clock.now().toString()).toBe('2030-01-01T00:00:00Z');

    clock.set(Temporal.Instant.from('2020-01-01T00:00:00Z'));
    expect(clock.now().toString()).toBe('2020-01-01T00:00:00Z');
  });

  it('keeps the Clock contract: every instant is truncated to the millisecond', () => {
    const clock = new FixedClock(Temporal.Instant.from('2026-10-03T16:00:00.123456789Z'));
    expect(clock.now().toString()).toBe('2026-10-03T16:00:00.123Z');

    clock.advance(Temporal.Duration.from({ microseconds: 1999 }));
    expect(clock.now().toString()).toBe('2026-10-03T16:00:00.124Z');

    clock.set(Temporal.Instant.from('2026-10-03T16:00:00.999999999Z'));
    expect(clock.now().toString()).toBe('2026-10-03T16:00:00.999Z');
  });
});

describe('SequenceIdGenerator', () => {
  const counter = (n: number): Uint8Array => Uint8Array.of(0, 0, 0, 0, 0, 0, 0, 0, 0, n);

  it('builds ids from the clock time and a counter with uuidV7', () => {
    const generator: IdGenerator = new SequenceIdGenerator(new FixedClock(START));

    expect(generator.next()).toBe(uuidV7(START.epochMilliseconds, counter(1)));
    expect(generator.next()).toBe(uuidV7(START.epochMilliseconds, counter(2)));
  });

  it('is predictable: the same clock gives the same ids', () => {
    const first = new SequenceIdGenerator(new FixedClock(START));
    const second = new SequenceIdGenerator(new FixedClock(START));

    expect(first.next()).toBe('01a1027e-647b-7000-8000-000000000001');
    expect(second.next()).toBe('01a1027e-647b-7000-8000-000000000001');
    expect(first.next()).toBe(second.next());
  });

  it('gives valid version 7 ids', () => {
    const generator = new SequenceIdGenerator(new FixedClock(START));

    for (let i = 0; i < 300; i += 1) {
      const id = generator.next<'Account'>();
      expect(parseId(id)).toEqual({ ok: true, value: id });
    }
  });

  it('gives rising ids within one millisecond and across a clock advance', () => {
    const clock = new FixedClock(START);
    const generator = new SequenceIdGenerator(clock);
    const ids: string[] = [];

    for (let i = 0; i < 300; i += 1) ids.push(generator.next());
    clock.advance(Temporal.Duration.from({ milliseconds: 1 }));
    for (let i = 0; i < 300; i += 1) ids.push(generator.next());

    expect(new Set(ids).size).toBe(600);
    expect([...ids].sort()).toEqual(ids);
  });

  it('never repeats an id when the clock is set back: the counter does not reset', () => {
    const clock = new FixedClock(START);
    const generator = new SequenceIdGenerator(clock);

    const before = generator.next();
    clock.set(START.subtract({ milliseconds: 1 }));
    const after = generator.next();

    expect(after).toBe(uuidV7(START.epochMilliseconds - 1, counter(2)));
    expect(after).not.toBe(before);
  });

  it('carries the counter past two bytes: 65,537 ids at one instant are all distinct', () => {
    const generator = new SequenceIdGenerator(new FixedClock(START));
    const ids = new Set<string>();
    let last = '';

    for (let i = 0; i < 65_537; i += 1) {
      last = generator.next();
      ids.add(last);
    }

    expect(ids.size).toBe(65_537);
    // 65,537 is 0x01_00_01: the counter fills byte 7 as well as bytes 8 and 9.
    expect(last).toBe(uuidV7(START.epochMilliseconds, Uint8Array.of(0, 0, 0, 0, 0, 0, 0, 1, 0, 1)));
  });
});

describe('testMarketContext', () => {
  it.each([
    ['AU', 'mondapac'],
    ['ZZ', 'test-tenant'],
  ])('builds a context for %s / %s that the main entry accepts as minted', (market, tenant) => {
    const context: MarketContext = testMarketContext(market, tenant);

    expect(context).toEqual({ marketId: market, tenantId: tenant });
    expect(Object.isFrozen(context)).toBe(true);
    // The main entry and `/testing` share one build of the kernel: the builder records the
    // context in the same private set that the main entry's isMinted reads.
    expect(isMinted(context)).toBe(true);
  });

  it('throws on a malformed identifier instead of minting it', () => {
    // Anchored: mint's own TypeError also names both ids, so `/market id/` alone would not
    // prove that the builder checks them.
    expect(() => testMarketContext('au', 'mondapac')).toThrow(
      /^testMarketContext: malformed market id/,
    );
    expect(() => testMarketContext('AU', 'Mondapac')).toThrow(
      /^testMarketContext: malformed tenant id/,
    );
  });
});
