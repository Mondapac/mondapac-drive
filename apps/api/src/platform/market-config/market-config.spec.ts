import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readdirSync } from 'node:fs';
import { parseMarketId } from '@mondapac-drive/shared-kernel';
import {
  TEST_MARKET_CONFIG_DIRS,
  TEST_MARKET_IDS,
  TEST_MARKETS,
  testMarketId,
} from '../../../test/support/test-config';
import { InvalidMarketConfigError, loadMarketConfigs } from './market-config';
import { MarketNotHostedError, MarketRegistry } from './market-registry';

const QQ = testMarketId('QQ');

const DELIVERY = {
  rateCard: {
    vehicles: {
      car: {
        baseFee: 1000,
        perKm: 150,
        maxDistanceMetres: 60000,
        maxWeightGrams: 50000,
        maxVolumeLitres: 300,
        temperatures: ['ambient', 'chilled'],
      },
    },
    coldChainSurcharge: { ambient: 0, chilled: 300, frozen: 500 },
    scheduledDiscountBps: 1000,
  },
  coldChain: { chilled: { maxCelsius: 5 }, frozen: { maxCelsius: -15 } },
  scheduling: { minLeadMinutes: 60, maxDaysAhead: 7, minWindowMinutes: 60 },
  proofOfDelivery: { pinLength: 4, maxPinAttempts: 5 },
};

/** The identity and origin sections of the ZZ fixture: this spec checks the other sections. */
const ZZ_FILE = JSON.parse(
  readFileSync(path.join(TEST_MARKET_CONFIG_DIRS[1], 'ZZ.json'), 'utf8'),
) as { allowedOrigins: unknown; identity: unknown };
const DISPATCH = {
  offerTimeoutSeconds: 30,
  waveSize: 1,
  maxRounds: 5,
  scheduledLeadMinutes: 45,
  searchRadiusMetres: 8000,
  candidateLimit: 20,
};

const TRACKING = {
  ping: {
    maxAgeSeconds: 120,
    maxFutureSkewSeconds: 30,
    minIntervalSeconds: 3,
    maxAccuracyMetres: 500,
    maxSpeedKmh: 160,
  },
  livePositionTtlSeconds: 300,
  breadcrumbRetentionDays: 30,
  trackingLinkTtlHours: 24,
  streamIntervalSeconds: 5,
  nearestCouriers: { maxRadiusMetres: 20000, maxResults: 50 },
  etaRefreshSeconds: 60,
};

const NOTIFICATIONS = {
  webhooks: { maxAttempts: 8, firstRetrySeconds: 30, maxRetrySeconds: 3600 },
  sms: {
    senderId: 'Example',
    optOutText: 'Reply STOP to opt out',
    maxAttempts: 5,
    allowedCallingCodes: ['64'],
    templates: {
      booked: 'Booked {reference}: {trackingUrl}',
      on_the_way: 'On the way: {trackingUrl}',
      delivered: 'Delivered {reference}',
      failed: 'Not delivered {reference}',
    },
  },
};

const FLEET = {
  documents: [
    {
      type: 'licence',
      vehicleTypes: ['car'],
      coldChainOnly: false,
      perVehicle: false,
      expires: true,
    },
  ],
};

/** A complete `payouts` section (its own rules: payouts-config.spec.ts). */
const PAYOUTS = {
  earnings: {
    vehicles: { car: { perDelivery: 700, perKm: 100 } },
    coldChainBonus: { ambient: 0, chilled: 100, frozen: 200 },
    waiting: { freeMinutes: 5, perMinute: 20, maxPaidMinutes: 30 },
  },
  schedule: { cadence: 'weekly', weekday: 1, time: '03:00' },
  minimumPayout: 1000,
  tax: { rateBps: 1500, onTips: false, businessIdRequired: false },
  provider: {
    accountCountry: 'NZ',
    onboardingReturnUrl: 'https://drive.example.test/return',
    onboardingRefreshUrl: 'https://drive.example.test/refresh',
  },
};

const VALID = {
  code: 'QQ',
  status: 'active',
  defaultLocale: 'en-NZ',
  supportedLocales: ['en-NZ'],
  defaultCurrency: 'NZD',
  settlementCurrency: 'NZD',
  pricesIncludeTax: true,
  timezone: 'Pacific/Auckland',
  requestLimits: { anonymousIdentityPerMinute: 20, defaultPerMinute: 300 },
  tax: { defaultRateBps: 1500 },
  delivery: DELIVERY,
  allowedOrigins: ZZ_FILE.allowedOrigins,
  identity: ZZ_FILE.identity,
  dispatch: DISPATCH,
  tracking: TRACKING,
  notifications: NOTIFICATIONS,
  fleet: FLEET,
  payouts: PAYOUTS,
};

function directoryWith(files: Record<string, unknown>): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'markets-'));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(
      path.join(directory, name),
      typeof content === 'string' ? content : JSON.stringify(content),
    );
  }
  return directory;
}

describe('loadMarketConfigs', () => {
  it('loads every hosted market from the repository configuration and the fixtures', () => {
    const markets = loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS);

    expect([...markets.keys()]).toEqual([...TEST_MARKETS]);
    for (const code of TEST_MARKETS) {
      const market = markets.get(testMarketId(code));
      expect(market?.code).toBe(code);
      expect(market?.supportedLocales).toContain(market?.defaultLocale);
    }
  });

  it('keeps the two fixtures different in currency, locale, time zone, tax and limits', () => {
    const [first, second] = [
      ...loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS).values(),
    ];

    expect(first?.defaultCurrency).not.toBe(second?.defaultCurrency);
    expect(first?.defaultLocale).not.toBe(second?.defaultLocale);
    expect(first?.timezone).not.toBe(second?.timezone);
    expect(first?.pricesIncludeTax).not.toBe(second?.pricesIncludeTax);
    expect(first?.tax).not.toEqual(second?.tax);
    expect(first?.requestLimits).not.toEqual(second?.requestLimits);
    expect(first?.delivery.rateCard).not.toEqual(second?.delivery.rateCard);
  });

  it('loads only the hosted markets', () => {
    const markets = loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, [testMarketId('ZZ')]);

    expect([...markets.keys()]).toEqual(['ZZ']);
  });

  it('freezes every section, so no caller can change a policy value after boot', () => {
    const market = loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS).get(
      testMarketId('AU'),
    );

    expect(Object.isFrozen(market)).toBe(true);
    expect(Object.isFrozen(market?.requestLimits)).toBe(true);
    expect(Object.isFrozen(market?.delivery.rateCard.vehicles)).toBe(true);
  });

  it('fails when a hosted market has no configuration file', () => {
    const hosted = ['AU', 'NZ'].map(testMarketId);

    expect(() => loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, hosted)).toThrow(
      /Hosted market "NZ" has no configuration file/,
    );
  });

  it('accepts a complete Market file', () => {
    const directory = directoryWith({ 'QQ.json': VALID });

    expect(loadMarketConfigs([directory], [QQ]).get(QQ)?.delivery).toEqual(DELIVERY);
  });

  const delivery = (overrides: Record<string, unknown>) => ({
    delivery: { ...DELIVERY, ...overrides },
  });

  it.each([
    ['an unknown currency', { defaultCurrency: 'XXQ' }, /defaultCurrency/],
    ['an unknown time zone', { timezone: 'Mars/Olympus' }, /timezone/],
    [
      'a malformed locale',
      { defaultLocale: 'english', supportedLocales: ['english'] },
      /defaultLocale/,
    ],
    ['a default locale that is not supported', { supportedLocales: ['mi-NZ'] }, /supportedLocales/],
    ['an unknown status', { status: 'live' }, /status/],
    ['an unknown field', { vatRate: 0.15 }, /vatRate|Unrecognized/],
    ['a code that differs from the file name', { code: 'QX' }, /must match the file name/],
    ['no request limits', { requestLimits: undefined }, /requestLimits/],
    [
      'a zero request limit',
      { requestLimits: { anonymousIdentityPerMinute: 0, defaultPerMinute: 300 } },
      /requestLimits\.anonymousIdentityPerMinute/,
    ],
    ['no tax section', { tax: undefined }, /tax/],
    ['a tax rate above 50 %', { tax: { defaultRateBps: 5001 } }, /tax\.defaultRateBps/],
    ['no delivery section', { delivery: undefined }, /delivery/],
    ['no dispatch section', { dispatch: undefined }, /dispatch/],
    [
      'an offer timeout under 5 s',
      { dispatch: { ...DISPATCH, offerTimeoutSeconds: 2 } },
      /dispatch\.offerTimeoutSeconds/,
    ],
    ['an empty wave', { dispatch: { ...DISPATCH, waveSize: 0 } }, /dispatch\.waveSize/],
    ['no tracking section', { tracking: undefined }, /tracking/],
    [
      'an ETA refresh of zero',
      { tracking: { ...TRACKING, etaRefreshSeconds: 0 } },
      /tracking\.etaRefreshSeconds/,
    ],
    [
      'a breadcrumb retention above a year',
      { tracking: { ...TRACKING, breadcrumbRetentionDays: 366 } },
      /tracking\.breadcrumbRetentionDays/,
    ],
    [
      'a rate card with no vehicle',
      delivery({ rateCard: { ...DELIVERY.rateCard, vehicles: {} } }),
      /delivery\.rateCard\.vehicles/,
    ],
    [
      'an unknown vehicle',
      delivery({
        rateCard: { ...DELIVERY.rateCard, vehicles: { drone: DELIVERY.rateCard.vehicles.car } },
      }),
      /delivery\.rateCard\.vehicles/,
    ],
    [
      'a fractional fee',
      delivery({
        rateCard: {
          ...DELIVERY.rateCard,
          vehicles: { car: { ...DELIVERY.rateCard.vehicles.car, baseFee: 9.5 } },
        },
      }),
      /delivery\.rateCard\.vehicles\.car\.baseFee/,
    ],
    [
      'an unknown temperature',
      delivery({
        rateCard: {
          ...DELIVERY.rateCard,
          vehicles: { car: { ...DELIVERY.rateCard.vehicles.car, temperatures: ['warm'] } },
        },
      }),
      /delivery\.rateCard\.vehicles\.car\.temperatures/,
    ],
    [
      'a frozen limit above zero',
      delivery({ coldChain: { ...DELIVERY.coldChain, frozen: { maxCelsius: 2 } } }),
      /delivery\.coldChain\.frozen\.maxCelsius/,
    ],
    [
      'a discount above 100 %',
      delivery({ rateCard: { ...DELIVERY.rateCard, scheduledDiscountBps: 10_001 } }),
      /delivery\.rateCard\.scheduledDiscountBps/,
    ],
    ['no scheduling rules', delivery({ scheduling: undefined }), /delivery\.scheduling/],
    [
      'a PIN shorter than 4 digits',
      delivery({ proofOfDelivery: { pinLength: 3, maxPinAttempts: 5 } }),
      /delivery\.proofOfDelivery\.pinLength/,
    ],
    ['no fleet section', { fleet: undefined }, /fleet/],
    [
      'a document type that is not a code',
      { fleet: { documents: [{ ...FLEET.documents[0], type: 'Driver Licence' }] } },
      /fleet\.documents\.0\.type/,
    ],
    [
      'a document listed twice',
      { fleet: { documents: [FLEET.documents[0], FLEET.documents[0]] } },
      /each document type is listed once/,
    ],
    [
      'an unknown employment type',
      { fleet: { documents: [{ ...FLEET.documents[0], employmentTypes: ['volunteer'] }] } },
      /fleet\.documents\.0\.employmentTypes/,
    ],
  ])('rejects %s', (_case, overrides, message) => {
    const directory = directoryWith({ 'QQ.json': { ...VALID, ...overrides } });

    expect(() => loadMarketConfigs([directory], [QQ])).toThrow(InvalidMarketConfigError);
    expect(() => loadMarketConfigs([directory], [QQ])).toThrow(message);
  });

  it.each(['pricesIncludeTax', 'timezone', 'defaultCurrency'])(
    'requires %s, with no default',
    (key) => {
      const file = Object.fromEntries(Object.entries(VALID).filter(([name]) => name !== key));
      expect(() => loadMarketConfigs([directoryWith({ 'QQ.json': file })], [QQ])).toThrow(
        InvalidMarketConfigError,
      );
    },
  );

  it('rejects a file that is not JSON', () => {
    const directory = directoryWith({ 'QQ.json': '{ not json' });

    expect(() => loadMarketConfigs([directory], [QQ])).toThrow(/is not valid JSON/);
  });

  it('rejects a market configured in two directories', () => {
    const first = directoryWith({ 'QQ.json': VALID });
    const second = directoryWith({ 'QQ.json': VALID });

    expect(() => loadMarketConfigs([first, second], [QQ])).toThrow(/more than once/);
  });
});

describe('the Market fixtures', () => {
  // Platform-foundations design section 9: the kernel specs cannot read these files, so the
  // kernel's single Market rule is asserted against them here.
  it('name every configuration file with a code the kernel parseMarketId accepts', () => {
    const codes = TEST_MARKET_CONFIG_DIRS.flatMap((directory) =>
      readdirSync(directory)
        .filter((name) => name.endsWith('.json'))
        .map((name) => name.slice(0, -'.json'.length)),
    );

    expect(codes).toEqual(expect.arrayContaining([...TEST_MARKETS]));
    for (const code of codes) expect(parseMarketId(code).ok).toBe(true);
  });

  it('give the loaded configurations parsed codes', () => {
    for (const market of loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS).values()) {
      expect(parseMarketId(market.code)).toEqual({ ok: true, value: market.code });
    }
  });
});

describe('MarketRegistry', () => {
  const registry = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));

  it.each(TEST_MARKETS)('returns the configuration of hosted market %s', (code) => {
    expect(registry.isHosted(testMarketId(code))).toBe(true);
    expect(registry.get(testMarketId(code)).code).toBe(code);
  });

  it('lists the hosted markets in HOSTED_MARKETS order', () => {
    expect(registry.hostedMarketIds()).toEqual([...TEST_MARKETS]);
  });

  it('rejects a market this Region Stack does not host', () => {
    expect(registry.isHosted(testMarketId('NZ'))).toBe(false);
    expect(() => registry.get(testMarketId('NZ'))).toThrow(MarketNotHostedError);
  });
});
