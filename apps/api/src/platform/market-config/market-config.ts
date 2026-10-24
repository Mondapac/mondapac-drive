import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parseMarketId } from '@mondapac-drive/shared-kernel';
import type { MarketId } from '@mondapac-drive/shared-kernel';
import { z } from 'zod';
import { routingConfigSchema } from '../routing/routing-config';
import { notificationsSchema } from './notifications-section';

const CURRENCIES = new Set(Intl.supportedValuesOf('currency'));
const TIME_ZONES = new Set(Intl.supportedValuesOf('timeZone'));

// Market locales always name a region: language[-Script]-REGION.
const LOCALE_SHAPE = /^[a-z]{2,3}(-[A-Z][a-z]{3})?-[A-Z]{2}$/;
const locale = z.string().refine((value) => {
  if (!LOCALE_SHAPE.test(value)) return false;
  try {
    return Intl.getCanonicalLocales(value)[0] === value;
  } catch {
    return false;
  }
}, 'must be a BCP 47 locale of the form language-REGION');
const currency = z.string().refine((value) => CURRENCIES.has(value), 'must be an ISO 4217 code');
/** The Market code, by the kernel's single rule (`parseMarketId`). */
const marketCode = z.string().transform((value, context) => {
  const marketId = parseMarketId(value);
  if (marketId.ok) return marketId.value;
  context.addIssue('must be a market code such as "NZ"');
  return z.NEVER;
});

/** A per-minute limit of the generic per-origin rate limiter (identity design 6.8). */
const perMinute = z.number().int().min(1).max(100_000);

/**
 * Limits of the generic per-origin rate limiter (`platform/rate-limit/`; identity design 6.8,
 * ADR-0015 decision 3). The counters are kept per origin and are not split by Market (PF I11):
 * the limiter is the cross-Market control, and the request's Market chooses only the limit.
 */
const requestLimitsSchema = z.strictObject({
  /** Routes marked `@RateLimit('anonymous-identity')`: sign-up, sign-in, reset requests. */
  anonymousIdentityPerMinute: perMinute,
  /** Every other market-scoped route. */
  defaultPerMinute: perMinute,
});

/** Vehicle types in order of size (delivery domain); a Market's rate card offers some of them. */
export const VEHICLE_TYPES = ['bicycle', 'motorbike', 'car', 'van'] as const;
/** Parcel temperatures; chilled and frozen need cold-chain readings on the way. */
export const TEMPERATURES = ['ambient', 'chilled', 'frozen'] as const;

/** Minor units of the Market's currency. */
const minor = z.number().int().nonnegative().max(10_000_000);
const basisPoints = z.number().int().min(0).max(10_000);

/** One vehicle's prices and limits. */
const vehicleRateSchema = z.strictObject({
  baseFee: minor,
  perKm: minor,
  maxDistanceMetres: z.number().int().positive(),
  maxWeightGrams: z.number().int().positive(),
  maxVolumeLitres: z.number().int().positive(),
  temperatures: z.array(z.enum(TEMPERATURES)).min(1),
});

/**
 * The `delivery` section, owned by the delivery module (Drive's addition to the marketplace's
 * Market file): the rate card, the cold-chain limits and the scheduling rules. Service areas are
 * the platform's `config/service-areas/<CODE>.json`.
 */
const deliverySchema = z.strictObject({
  rateCard: z
    .strictObject({
      vehicles: z.partialRecord(z.enum(VEHICLE_TYPES), vehicleRateSchema),
      coldChainSurcharge: z.strictObject({ ambient: minor, chilled: minor, frozen: minor }),
      scheduledDiscountBps: basisPoints,
    })
    .refine((card) => Object.keys(card.vehicles).length > 0, {
      message: 'the rate card offers no vehicle',
      path: ['vehicles'],
    }),
  coldChain: z.strictObject({
    chilled: z.strictObject({ maxCelsius: z.number().min(-40).max(15) }),
    frozen: z.strictObject({ maxCelsius: z.number().min(-40).max(0) }),
  }),
  scheduling: z.strictObject({
    minLeadMinutes: z.number().int().nonnegative(),
    maxDaysAhead: z.number().int().positive().max(90),
    minWindowMinutes: z.number().int().positive(),
  }),
});

/** Employment types of the hybrid fleet (fleet domain). */
export const EMPLOYMENT_TYPES = ['employee', 'contractor'] as const;

/**
 * The `fleet` section, owned by the fleet module: the documents the Market requires of its
 * couriers. A document type is the Market's own code (`abn` in AU), never a list in core code.
 */
const fleetSchema = z.strictObject({
  documents: z
    .array(
      z.strictObject({
        type: z.string().regex(/^[a-z][a-z0-9_]{1,39}$/, 'must be a lower-case code'),
        employmentTypes: z.array(z.enum(EMPLOYMENT_TYPES)).min(1).optional(),
        vehicleTypes: z.array(z.enum(VEHICLE_TYPES)).min(1).optional(),
        coldChainOnly: z.boolean(),
        perVehicle: z.boolean(),
        expires: z.boolean(),
      }),
    )
    .max(50)
    .refine((documents) => new Set(documents.map((d) => d.type)).size === documents.length, {
      message: 'each document type is listed once',
    }),
});

const marketSchema = z
  .strictObject({
    code: marketCode,
    status: z.enum(['planned', 'soft_launch', 'active', 'suspended']),
    defaultLocale: locale,
    supportedLocales: z.array(locale).min(1),
    defaultCurrency: currency,
    settlementCurrency: currency,
    /**
     * The Market's price display convention (marketplace ADR-0007 decision 4): true when prices
     * are entered and shown tax-inclusive (AU). Required: a Market never defaults it.
     */
    pricesIncludeTax: z.boolean(),
    /** Fallback only (ADR-0005): areas, depots and addresses may carry their own zone. */
    timezone: z.string().refine((value) => TIME_ZONES.has(value), 'must be an IANA time zone'),
    requestLimits: requestLimitsSchema,
    /** `defaultRateBps`: the tax rate inside or on top of a delivery fee (AU GST 1000 = 10 %). */
    tax: z.strictObject({ defaultRateBps: z.number().int().min(0).max(5000) }),
    delivery: deliverySchema,
    /** Owned by `platform/routing`; absent, routes are straight-line estimates. */
    routing: routingConfigSchema.optional(),
    notifications: notificationsSchema,
    fleet: fleetSchema,
  })
  .refine((market) => market.supportedLocales.includes(market.defaultLocale), {
    message: 'supportedLocales must include defaultLocale',
    path: ['supportedLocales'],
  });

/** Market configuration as code (ADR-0003 decision 5). */
export type MarketConfig = Readonly<z.infer<typeof marketSchema>>;

export class InvalidMarketConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidMarketConfigError';
  }
}

/**
 * Reads `<CODE>.json` for each hosted market from the given directories and validates it.
 * Throws when a hosted market has no configuration or an invalid one, so a Region Stack
 * never starts half-configured.
 */
export function loadMarketConfigs(
  directories: readonly string[],
  hostedMarkets: readonly MarketId[],
): ReadonlyMap<MarketId, MarketConfig> {
  const files = new Map<string, string>();
  for (const directory of directories) {
    for (const name of readdirSync(directory)) {
      if (!name.endsWith('.json')) continue;
      const code = path.basename(name, '.json');
      if (files.has(code)) {
        throw new InvalidMarketConfigError(`Market "${code}" is configured more than once`);
      }
      files.set(code, path.join(directory, name));
    }
  }

  const markets = new Map<MarketId, MarketConfig>();
  for (const code of hostedMarkets) {
    const file = files.get(code);
    if (file === undefined) {
      throw new InvalidMarketConfigError(
        `Hosted market "${code}" has no configuration file (${code}.json)`,
      );
    }

    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      throw new InvalidMarketConfigError(`${file} is not valid JSON`);
    }
    const parsed = marketSchema.safeParse(raw);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((issue) => `${issue.path.join('.') || 'market'}: ${issue.message}`)
        .join('; ');
      throw new InvalidMarketConfigError(`${file} is invalid: ${issues}`);
    }
    if (parsed.data.code !== code) {
      throw new InvalidMarketConfigError(
        `${file} declares code "${parsed.data.code}"; it must match the file name`,
      );
    }
    markets.set(code, deepFreeze(parsed.data));
  }
  return markets;
}

/** Freezes the parsed configuration and every nested section: it never changes after boot. */
function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}
