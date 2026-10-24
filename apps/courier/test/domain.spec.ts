import { secondsLeft } from '../src/domain/countdown';
import { formatDistance, formatMoney } from '../src/domain/format';
import { canReportFailure, currentStop, nextStep } from '../src/domain/job-flow';
import { directionsUrl } from '../src/domain/navigation';
import { DELIVERY_STATUSES } from '../src/api/schemas';
import { MARKETS } from './markets';

describe('job flow', () => {
  it('offers one step per status, in the order of the delivery lifecycle', () => {
    expect(
      ['ASSIGNED', 'AT_PICKUP', 'PICKED_UP', 'AT_DROPOFF'].map((s) => nextStep(s as never)),
    ).toEqual(['arrive_at_pickup', 'pick_up', 'arrive_at_dropoff', 'deliver']);
    for (const status of ['DELIVERED', 'DELIVERY_FAILED', 'RETURNED', 'CANCELLED'] as const) {
      expect(nextStep(status)).toBe('finished');
    }
  });

  it('allows a failure report only once the goods are on board', () => {
    const allowed = DELIVERY_STATUSES.filter(canReportFailure);
    expect(allowed).toEqual(['PICKED_UP', 'AT_DROPOFF']);
  });

  it('points at the pickup, then the drop-off', () => {
    expect(currentStop('ASSIGNED')).toBe('pickup');
    expect(currentStop('AT_DROPOFF')).toBe('dropoff');
    expect(currentStop('DELIVERED')).toBeNull();
  });
});

describe('offer countdown', () => {
  const expiresAt = '2026-10-24T09:00:30Z';
  it('rounds up and stops at zero', () => {
    expect(secondsLeft(expiresAt, Date.parse('2026-10-24T09:00:00Z'))).toBe(30);
    expect(secondsLeft(expiresAt, Date.parse('2026-10-24T09:00:29.200Z'))).toBe(1);
    expect(secondsLeft(expiresAt, Date.parse('2026-10-24T09:01:00Z'))).toBe(0);
    expect(secondsLeft('not a date', 0)).toBe(0);
  });
});

describe.each(MARKETS)('money and distance in $marketId', (settings) => {
  it('formats minor units with the digits of the currency', () => {
    const text = formatMoney({ amount: '1250', currency: settings.currency }, settings.locale);
    const digits = new Intl.NumberFormat(settings.locale, {
      style: 'currency',
      currency: settings.currency,
    }).resolvedOptions().maximumFractionDigits;
    // 1250 minor units: 12.50 in a two-digit currency, 1,250 in a zero-digit one (JPY in ZZ).
    expect(text).toContain(digits === 0 ? '1,250' : '12.50');
  });

  it('formats distance in the unit the API sends', () => {
    expect(formatDistance(4200, 'km', settings.locale)).toMatch(/4\.2\s?km/);
  });
});

describe('navigation deep link', () => {
  const point = { lat: -27.47, lng: 153.02 };
  it('opens the platform map app', () => {
    expect(directionsUrl(point, 'ios')).toBe('maps://?daddr=-27.47,153.02&dirflg=d');
    expect(directionsUrl(point, 'android')).toBe('google.navigation:q=-27.47,153.02');
    expect(directionsUrl(point, 'web')).toContain('destination=-27.47,153.02');
  });

  it('navigates by address when the stop has no point', () => {
    expect(directionsUrl('5 Sample St, Coorparoo', 'android')).toBe(
      'google.navigation:q=5%20Sample%20St%2C%20Coorparoo',
    );
  });
});
