import { payoutsSchema } from './payouts-config';

// The `payouts` section of a Market file: complete files are in config/markets and the test
// fixtures; these are the refusals, each naming the offending path.

const VALID = {
  earnings: {
    vehicles: { car: { perDelivery: 700, perKm: 100 } },
    coldChainBonus: { ambient: 0, chilled: 100, frozen: 200 },
    waiting: { freeMinutes: 5, perMinute: 20, maxPaidMinutes: 30 },
  },
  schedule: { cadence: 'weekly', weekday: 1, time: '03:00' },
  minimumPayout: 1000,
  tax: { rateBps: 1000, onTips: false, businessIdRequired: true },
  provider: {
    accountCountry: 'AU',
    onboardingReturnUrl: 'https://drive.example.test/return',
    onboardingRefreshUrl: 'https://drive.example.test/refresh',
  },
};

const issuesOf = (value: unknown): string[] => {
  const parsed = payoutsSchema.safeParse(value);
  return parsed.success ? [] : parsed.error.issues.map((issue) => issue.path.join('.'));
};

describe('the payouts section of a Market file', () => {
  it('accepts a complete section', () => {
    expect(issuesOf(VALID)).toEqual([]);
  });

  it.each([
    ['no vehicle rate', { earnings: { ...VALID.earnings, vehicles: {} } }, 'earnings.vehicles'],
    [
      'a fractional rate',
      { earnings: { ...VALID.earnings, vehicles: { car: { perDelivery: 7.5, perKm: 100 } } } },
      'earnings.vehicles.car.perDelivery',
    ],
    [
      'an unknown vehicle',
      { earnings: { ...VALID.earnings, vehicles: { drone: { perDelivery: 1, perKm: 1 } } } },
      'earnings.vehicles',
    ],
    [
      'an unknown cadence',
      { schedule: { ...VALID.schedule, cadence: 'monthly' } },
      'schedule.cadence',
    ],
    ['weekday 0', { schedule: { ...VALID.schedule, weekday: 0 } }, 'schedule.weekday'],
    ['a malformed time', { schedule: { ...VALID.schedule, time: '24:00' } }, 'schedule.time'],
    ['a negative minimum', { minimumPayout: -1 }, 'minimumPayout'],
    ['a tax rate above 50 %', { tax: { ...VALID.tax, rateBps: 5001 } }, 'tax.rateBps'],
    [
      'a lower-case country',
      { provider: { ...VALID.provider, accountCountry: 'au' } },
      'provider.accountCountry',
    ],
    [
      'a plain-http return URL',
      { provider: { ...VALID.provider, onboardingReturnUrl: 'http://drive.example.test/r' } },
      'provider.onboardingReturnUrl',
    ],
    [
      'a refresh URL with a query',
      { provider: { ...VALID.provider, onboardingRefreshUrl: 'https://drive.example.test/r?x=1' } },
      'provider.onboardingRefreshUrl',
    ],
    ['an unknown field', { payday: 'friday' }, ''],
  ])('refuses %s', (_case, overrides, path) => {
    expect(issuesOf({ ...VALID, ...overrides })).toContain(path);
  });
});
