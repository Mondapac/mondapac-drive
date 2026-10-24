import { Temporal } from '@mondapac-drive/shared-kernel';
import { PayoutsDomainError } from './errors';
import type { PayoutSchedule } from './payout-settings';

const TIME = /^([01][0-9]|2[0-3]):([0-5][0-9])$/;

/**
 * The cutoff of the latest payout period that has closed at `now`: the most recent scheduled
 * local time (every week on the schedule's weekday, or every day) in the Market's time zone, at
 * or before `now`. A run pays what was earned before its cutoff. Local times follow the zone's
 * daylight-saving rules: a cutoff in a skipped hour moves forward, as Temporal resolves it.
 */
export function latestCutoff(
  schedule: PayoutSchedule,
  timezone: string,
  now: Temporal.Instant,
): Temporal.Instant {
  const match = TIME.exec(schedule.time);
  if (match === null) {
    throw new PayoutsDomainError('schedule.invalid-time', 'A cutoff time is "HH:MM"');
  }
  if (!Number.isInteger(schedule.weekday) || schedule.weekday < 1 || schedule.weekday > 7) {
    throw new PayoutsDomainError('schedule.invalid-weekday', 'A weekday is 1 (Monday) to 7');
  }
  const local = now.toZonedDateTimeISO(timezone);
  const time = new Temporal.PlainTime(Number(match[1]), Number(match[2]));
  const daysBack = schedule.cadence === 'weekly' ? (local.dayOfWeek - schedule.weekday + 7) % 7 : 0;
  let cutoff = local.subtract({ days: daysBack }).withPlainTime(time);
  if (Temporal.ZonedDateTime.compare(cutoff, local) > 0) {
    cutoff = cutoff.subtract(schedule.cadence === 'weekly' ? { weeks: 1 } : { days: 1 });
    cutoff = cutoff.withPlainTime(time);
  }
  return cutoff.toInstant();
}
