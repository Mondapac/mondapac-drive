// Through the main entry, so these tests also check the re-export.
import { Temporal } from './index';

// ADR-0005 decision 8: Brisbane (no DST), Sydney (DST), Adelaide (half hour + DST), Perth.
const BRISBANE = 'Australia/Brisbane';
const SYDNEY = 'Australia/Sydney';
const ADELAIDE = 'Australia/Adelaide';
const PERTH = 'Australia/Perth';

const local = (instant: Temporal.Instant, zone: string): string =>
  instant.toZonedDateTimeISO(zone).toString({ timeZoneName: 'never' });

describe('Temporal through the kernel', () => {
  it('is not installed as a global', () => {
    expect((globalThis as { Temporal?: unknown }).Temporal).not.toBe(Temporal);
  });

  it('converts one instant in the four launch-market zones', () => {
    const instant = Temporal.Instant.from('2026-07-01T02:15:00Z');

    expect(local(instant, BRISBANE)).toBe('2026-07-01T12:15:00+10:00');
    expect(local(instant, SYDNEY)).toBe('2026-07-01T12:15:00+10:00');
    expect(local(instant, ADELAIDE)).toBe('2026-07-01T11:45:00+09:30');
    expect(local(instant, PERTH)).toBe('2026-07-01T10:15:00+08:00');
  });

  it('gives one instant a different local date per zone', () => {
    const instant = Temporal.Instant.from('2026-07-01T14:30:00Z');
    const dateIn = (zone: string): string =>
      instant.toZonedDateTimeISO(zone).toPlainDate().toString();

    expect(dateIn(BRISBANE)).toBe('2026-07-02');
    expect(dateIn(ADELAIDE)).toBe('2026-07-02');
    expect(dateIn(PERTH)).toBe('2026-07-01');
  });

  describe('on the day daylight saving starts (2026-10-04)', () => {
    const before = Temporal.Instant.from('2026-10-03T15:59:59Z');
    const sydneyChange = Temporal.Instant.from('2026-10-03T16:00:00Z');
    const adelaideChange = Temporal.Instant.from('2026-10-03T16:30:00Z');

    it('moves Sydney from 01:59:59 +10:00 to 03:00:00 +11:00', () => {
      expect(local(before, SYDNEY)).toBe('2026-10-04T01:59:59+10:00');
      expect(local(sydneyChange, SYDNEY)).toBe('2026-10-04T03:00:00+11:00');
    });

    it('moves Adelaide half an hour of real time later, from +09:30 to +10:30', () => {
      expect(local(sydneyChange, ADELAIDE)).toBe('2026-10-04T01:30:00+09:30');
      expect(local(adelaideChange, ADELAIDE)).toBe('2026-10-04T03:00:00+10:30');
    });

    it('leaves Brisbane and Perth alone', () => {
      expect(local(before, BRISBANE)).toBe('2026-10-04T01:59:59+10:00');
      expect(local(sydneyChange, BRISBANE)).toBe('2026-10-04T02:00:00+10:00');
      expect(local(before, PERTH)).toBe('2026-10-03T23:59:59+08:00');
      expect(local(sydneyChange, PERTH)).toBe('2026-10-04T00:00:00+08:00');
    });

    it('makes the local day 23 hours long where the clocks change', () => {
      const hoursIn = (zone: string): number =>
        Temporal.PlainDate.from('2026-10-04').toZonedDateTime(zone).hoursInDay;

      expect(hoursIn(SYDNEY)).toBe(23);
      expect(hoursIn(ADELAIDE)).toBe(23);
      expect(hoursIn(BRISBANE)).toBe(24);
      expect(hoursIn(PERTH)).toBe(24);
    });

    it('has no 02:30 in Sydney: the skipped time is refused or moved forward, on request', () => {
      const skipped = Temporal.PlainDateTime.from('2026-10-04T02:30:00');

      expect(() => skipped.toZonedDateTime(SYDNEY, { disambiguation: 'reject' })).toThrow(
        RangeError,
      );
      expect(skipped.toZonedDateTime(SYDNEY, { disambiguation: 'compatible' }).toString()).toBe(
        '2026-10-04T03:30:00+11:00[Australia/Sydney]',
      );
      expect(skipped.toZonedDateTime(BRISBANE, { disambiguation: 'reject' }).toString()).toBe(
        '2026-10-04T02:30:00+10:00[Australia/Brisbane]',
      );
    });
  });

  describe('on the day daylight saving ends (2027-04-04)', () => {
    it('repeats 02:00 to 03:00 in Sydney and makes the day 25 hours long', () => {
      const firstPass = Temporal.Instant.from('2027-04-03T15:30:00Z');
      const secondPass = Temporal.Instant.from('2027-04-03T16:30:00Z');

      expect(local(firstPass, SYDNEY)).toBe('2027-04-04T02:30:00+11:00');
      expect(local(secondPass, SYDNEY)).toBe('2027-04-04T02:30:00+10:00');
      expect(Temporal.PlainDate.from('2027-04-04').toZonedDateTime(SYDNEY).hoursInDay).toBe(25);
      expect(Temporal.PlainDate.from('2027-04-04').toZonedDateTime(BRISBANE).hoursInDay).toBe(24);
    });
  });

  it('adds a duration to an instant without any zone', () => {
    const sixtyMinutes = Temporal.Duration.from({ minutes: 60 });

    expect(Temporal.Instant.from('2026-10-03T15:30:00Z').add(sixtyMinutes).toString()).toBe(
      '2026-10-03T16:30:00Z',
    );
  });

  it('keeps a millisecond instant unchanged through its ISO text and epoch milliseconds', () => {
    const instant = Temporal.Instant.from('2026-10-03T16:00:00.123Z');

    expect(Temporal.Instant.from(instant.toString()).equals(instant)).toBe(true);
    expect(Temporal.Instant.fromEpochMilliseconds(instant.epochMilliseconds).equals(instant)).toBe(
      true,
    );
    expect(JSON.stringify({ at: instant })).toBe('{"at":"2026-10-03T16:00:00.123Z"}');
  });
});
