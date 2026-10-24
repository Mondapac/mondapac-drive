import { Temporal } from '@mondapac-drive/shared-kernel';
import { AU, payoutMarkets, ZZ } from '../../../../test/support/payouts-markets';
import { latestCutoff } from './payout-schedule';

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
