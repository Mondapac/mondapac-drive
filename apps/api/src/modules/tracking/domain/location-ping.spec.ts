import { Temporal } from '@mondapac-drive/shared-kernel';
import { trackingSettings } from '../../../../test/support/tracking-markets';
import { TEST_MARKET_IDS } from '../../../../test/support/test-config';
import { checkPing, type LocationPing } from './location-ping';

const now = Temporal.Instant.from('2026-11-02T00:00:00Z');

describe.each(TEST_MARKET_IDS)('location ping rules in market %s', (marketId) => {
  const settings = trackingSettings.get(marketId);
  const ping = (overrides: Partial<LocationPing> = {}): LocationPing => ({
    courierId: 'courier-1',
    point: { lat: -27.47, lng: 153.02 },
    accuracyMetres: 10,
    headingDegrees: 90,
    speedKmh: 25,
    recordedAt: now.subtract({ seconds: 5 }),
    ...overrides,
  });

  it('accepts a fresh, plausible ping', () => {
    expect(checkPing(settings, ping(), now)).toEqual({ ok: true, value: ping() });
  });

  it.each([
    ['latitude above 90', { point: { lat: 90.5, lng: 0 } }, 'lat'],
    ['longitude below -180', { point: { lat: 0, lng: -180.1 } }, 'lng'],
    ['a NaN coordinate', { point: { lat: Number.NaN, lng: 0 } }, 'lat'],
    ['a negative accuracy', { accuracyMetres: -1 }, 'accuracyM'],
    ['a heading of 360', { headingDegrees: 360 }, 'headingDeg'],
    ['a negative speed', { speedKmh: -3 }, 'speedKmh'],
    ['a malformed courier id', { courierId: 'courier 1' }, 'courierId'],
    ['a malformed service area', { serviceAreaCode: 'Not An Area' }, 'serviceArea'],
  ])('refuses %s, naming the field only', (_name, overrides, field) => {
    expect(checkPing(settings, ping(overrides), now)).toEqual({
      ok: false,
      error: { code: 'ping.invalid', field },
    });
  });

  it('refuses an accuracy or speed beyond the Market limit, and accepts them at the limit', () => {
    const { maxAccuracyMetres, maxSpeedKmh } = settings.ping;
    expect(checkPing(settings, ping({ accuracyMetres: maxAccuracyMetres }), now).ok).toBe(true);
    expect(checkPing(settings, ping({ accuracyMetres: maxAccuracyMetres + 1 }), now).ok).toBe(
      false,
    );
    expect(checkPing(settings, ping({ speedKmh: maxSpeedKmh }), now).ok).toBe(true);
    expect(checkPing(settings, ping({ speedKmh: maxSpeedKmh + 1 }), now).ok).toBe(false);
  });

  it('refuses a stale ping by the Market maximum age, from the injected time', () => {
    const { maxAgeSeconds } = settings.ping;
    const atLimit = ping({ recordedAt: now.subtract({ seconds: maxAgeSeconds }) });
    const tooOld = ping({ recordedAt: now.subtract({ seconds: maxAgeSeconds + 1 }) });
    expect(checkPing(settings, atLimit, now).ok).toBe(true);
    expect(checkPing(settings, tooOld, now)).toEqual({ ok: false, error: { code: 'ping.stale' } });
  });

  it('refuses a ping from the future beyond the allowed clock skew', () => {
    const { maxFutureSkewSeconds } = settings.ping;
    const skewed = ping({ recordedAt: now.add({ seconds: maxFutureSkewSeconds }) });
    const future = ping({ recordedAt: now.add({ seconds: maxFutureSkewSeconds + 1 }) });
    expect(checkPing(settings, skewed, now).ok).toBe(true);
    expect(checkPing(settings, future, now)).toEqual({ ok: false, error: { code: 'ping.future' } });
  });
});

it('the two Markets differ, so a rule that reads a constant fails one of them', () => {
  const [au, zz] = TEST_MARKET_IDS.map((id) => trackingSettings.get(id));
  expect(au!.ping.maxAgeSeconds).not.toBe(zz!.ping.maxAgeSeconds);
  expect(au!.breadcrumbRetentionDays).not.toBe(zz!.breadcrumbRetentionDays);
});
