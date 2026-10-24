import { z } from 'zod';

/** Vehicle types the router knows, in order of size (the delivery domain's list). */
export const ROUTING_VEHICLE_TYPES = ['bicycle', 'motorbike', 'car', 'van'] as const;
export type RoutingVehicleType = (typeof ROUTING_VEHICLE_TYPES)[number];

/** The travel modes of the Google Routes API that a vehicle may map to. */
export const GOOGLE_TRAVEL_MODES = ['DRIVE', 'TWO_WHEELER', 'BICYCLE', 'WALK'] as const;

const ENV_VAR_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
/** A Unicode CLDR region code, lower case (Google's `regionCode`, e.g. "au"). */
const REGION_CODE = /^[a-z]{2}$/;

const vehicleRecord = <T extends z.ZodType>(value: T) =>
  z.strictObject({ bicycle: value, motorbike: value, car: value, van: value });

const googleSchema = z.strictObject({
  /** The name of the environment variable holding the API key; the key is never in a file. */
  apiKeyEnv: z.string().regex(ENV_VAR_NAME, 'must be an environment variable name'),
  /** Region bias for routes and geocoding (`regionCode`, `region`, `components=country:`). */
  regionCode: z.string().regex(REGION_CODE, 'must be a two-letter region code such as "au"'),
  /** Travel mode per vehicle. TWO_WHEELER is offered only in some countries. */
  travelModes: vehicleRecord(z.enum(GOOGLE_TRAVEL_MODES)),
  /** Ask for traffic-aware durations on DRIVE and TWO_WHEELER (billed at a higher SKU). */
  trafficAware: z.boolean(),
});

/**
 * The `routing` section of a Market file, owned by `platform/routing`. Absent: every route is
 * the straight-line estimate with the defaults of {@link DEFAULT_ROUTING_CONFIG}.
 */
export const routingConfigSchema = z
  .strictObject({
    provider: z.enum(['google', 'straight_line']),
    google: googleSchema.optional(),
    /** How long one provider call may take before it counts as failed. */
    timeoutMs: z.number().int().min(100).max(30_000),
    /** How long a route stays in the cache. 0 turns caching off. */
    cacheTtlSeconds: z
      .number()
      .int()
      .min(0)
      .max(7 * 24 * 3600),
    /** Coordinates are rounded to this many decimals for the cache key (4 is about 11 m). */
    cacheCoordinateDecimals: z.number().int().min(2).max(6),
    circuitBreaker: z.strictObject({
      /** Consecutive failures that open the breaker. */
      failureThreshold: z.number().int().min(1).max(100),
      /** How long the breaker stays open before one trial call is let through. */
      openSeconds: z.number().int().min(1).max(3600),
    }),
    /** The fallback estimate: great-circle distance times a road factor, at a typical speed. */
    straightLine: z.strictObject({
      roadFactor: z.number().min(1).max(3),
      speedsKmh: vehicleRecord(z.number().min(1).max(150)),
    }),
  })
  .refine((routing) => routing.provider !== 'google' || routing.google !== undefined, {
    message: 'provider "google" needs the google section',
    path: ['google'],
  });

export type RoutingConfig = Readonly<z.infer<typeof routingConfigSchema>>;

/** For a Market without a `routing` section: the straight-line estimate only. */
export const DEFAULT_ROUTING_CONFIG: RoutingConfig = Object.freeze({
  provider: 'straight_line',
  timeoutMs: 2000,
  cacheTtlSeconds: 0,
  cacheCoordinateDecimals: 4,
  circuitBreaker: { failureThreshold: 5, openSeconds: 30 },
  straightLine: {
    roadFactor: 1.3,
    speedsKmh: { bicycle: 15, motorbike: 30, car: 30, van: 25 },
  },
});
