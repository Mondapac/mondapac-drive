import { Temporal } from '@mondapac-drive/shared-kernel';
import { AU, payoutMarkets, ZZ } from '../../../../test/support/payouts-markets';
import { earningPeriods, latestCutoff } from './payout-schedule';

const instant = (text: string) => Temporal.Instant.from(text);

describe('latestCutoff', () => {
  const au = payoutMarkets.get(AU);
  const zz = payoutMarkets.get(ZZ);

  it("closes AU's weekly period on Monday 03:00 in the Market's zone", () => {
    // Wednesday 10:00 local (UTC+10) -> Monday 2 November 03:00 local.
    expect(latestCutoff(au.schedule, au.timezone, instant('2026-11-04T00:00:00Z'))).toEqual(
      instant('2026-11-01T17:00:00Z'),
    );
  });

  it('includes the cutoff instant itself, and not a millisecond before it', () => {
    const cutoff = instant('2026-11-01T17:00:00Z');

    expect(latestCutoff(au.schedule, au.timezone, cutoff)).toEqual(cutoff);
    expect(latestCutoff(au.schedule, au.timezone, cutoff.subtract({ milliseconds: 1 }))).toEqual(
      instant('2026-10-25T17:00:00Z'),
    );
  });

  it("closes ZZ's daily period at 23:30 local, through daylight-saving time", () => {
    // 23:00 on 4 November in Auckland (UTC+13) -> 23:30 on 3 November.
    expect(latestCutoff(zz.schedule, zz.timezone, instant('2026-11-04T10:00:00Z'))).toEqual(
      instant('2026-11-03T10:30:00Z'),
    );
    // In June, Auckland is UTC+12.
    expect(latestCutoff(zz.schedule, zz.timezone, instant('2026-06-10T12:00:00Z'))).toEqual(
      instant('2026-06-10T11:30:00Z'),
    );
  });

  it('moves a cutoff in a skipped hour forward', () => {
    // Auckland skips 02:00-03:00 on 27 September 2026.
    const schedule = { ...zz.schedule, time: '02:30' };

    expect(latestCutoff(schedule, zz.timezone, instant('2026-09-27T00:00:00Z'))).toEqual(
      instant('2026-09-26T14:30:00Z'),
    );
  });

  it('refuses a malformed time or weekday', () => {
    expect(() =>
      latestCutoff({ ...au.schedule, time: '3:00' }, au.timezone, instant('2026-11-04T00:00:00Z')),
    ).toThrow(expect.objectContaining({ code: 'schedule.invalid-time' }) as Error);
    expect(() =>
      latestCutoff({ ...au.schedule, weekday: 8 }, au.timezone, instant('2026-11-04T00:00:00Z')),
    ).toThrow(expect.objectContaining({ code: 'schedule.invalid-weekday' }) as Error);
  });
});

describe('earningPeriods', () => {
  it.each([
    // Brisbane (UTC+10, no daylight saving): a Wednesday morning.
    ['AU', '2026-11-04T01:30:00Z', '2026-11-03T14:00:00Z', '2026-11-01T14:00:00Z'],
    // A Monday: the week starts today.
    ['AU', '2026-11-02T03:00:00Z', '2026-11-01T14:00:00Z', '2026-11-01T14:00:00Z'],
  ] as const)('in %s at %s', (code, at, day, week) => {
    const { timezone } = payoutMarkets.get(code === 'AU' ? AU : ZZ);
    expect(earningPeriods(timezone, Temporal.Instant.from(at))).toEqual({
      dayStart: Temporal.Instant.from(day),
      weekStart: Temporal.Instant.from(week),
    });
  });

  it('starts the day and the week at local midnight in the ZZ Market too', () => {
    const { timezone } = payoutMarkets.get(ZZ);
    const at = Temporal.Instant.from('2026-11-06T12:00:00Z');
    const { dayStart, weekStart } = earningPeriods(timezone, at);
    const local = (instant: Temporal.Instant) => instant.toZonedDateTimeISO(timezone);

    expect(local(dayStart).toPlainTime().toString()).toBe('00:00:00');
    expect(local(weekStart).dayOfWeek).toBe(1);
    expect(local(weekStart).toPlainTime().toString()).toBe('00:00:00');
    expect(Temporal.Instant.compare(weekStart, dayStart)).toBeLessThanOrEqual(0);
    expect(Temporal.Instant.compare(dayStart, at)).toBeLessThanOrEqual(0);
  });
});
