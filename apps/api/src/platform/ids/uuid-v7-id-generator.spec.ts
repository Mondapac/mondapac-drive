import { parseId, Temporal } from '@mondapac-drive/shared-kernel';
import { FixedClock } from '@mondapac-drive/shared-kernel/testing';
import { UuidV7IdGenerator } from './uuid-v7-id-generator';

const START = Temporal.Instant.from('2026-10-03T01:02:03.456Z');

/** The 48-bit millisecond timestamp at the start of a version 7 UUID. */
function timestampOf(id: string): number {
  return parseInt(id.replace(/-/g, '').slice(0, 12), 16);
}

describe('UuidV7IdGenerator', () => {
  it('returns canonical version 7 ids that parseId accepts', () => {
    const ids = new UuidV7IdGenerator(new FixedClock(START));

    for (let index = 0; index < 100; index += 1) {
      expect(parseId(ids.next()).ok).toBe(true);
    }
  });

  it('stamps each id with the time of the injected clock', () => {
    const clock = new FixedClock(START);
    const ids = new UuidV7IdGenerator(clock);

    expect(timestampOf(ids.next())).toBe(START.epochMilliseconds);
    clock.advance(Temporal.Duration.from({ hours: 1 }));
    expect(timestampOf(ids.next())).toBe(START.epochMilliseconds + 3_600_000);
  });

  it('fills the other bits from a random source: ids of one millisecond all differ', () => {
    const ids = new UuidV7IdGenerator(new FixedClock(START));
    const generated = new Set(Array.from({ length: 1000 }, () => ids.next()));

    expect(generated.size).toBe(1000);
  });

  it('sorts an id of a later millisecond after an id of an earlier one', () => {
    const clock = new FixedClock(START);
    const ids = new UuidV7IdGenerator(clock);

    const earlier = ids.next();
    clock.advance(Temporal.Duration.from({ milliseconds: 1 }));
    const later = ids.next();

    expect(later > earlier).toBe(true);
  });
});
