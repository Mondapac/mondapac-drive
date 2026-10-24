import { Temporal } from '@mondapac-drive/shared-kernel';
import { z } from 'zod';
import { MAX_PINGS_PER_REQUEST } from '../application/use-cases/record-location-ping.use-case';

/**
 * A courier's location ping. Ranges are checked here for a clear 400 and again by the domain
 * against the Market's limits (accuracy, speed, age). The courier is the session's: a
 * `courierId` the courier app still sends is accepted and dropped, never used.
 */
const ping = z.strictObject({
  courierId: z.string().max(64).optional(),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  accuracyM: z.number().min(0).max(10_000),
  headingDeg: z.number().min(0).lt(360).optional(),
  speedKmh: z.number().min(0).max(400).optional(),
  recordedAt: z.iso.datetime({ offset: true }).transform((value) => Temporal.Instant.from(value)),
  serviceArea: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{0,63}$/)
    .optional(),
});

/** A batch of the courier's latest fixes, at most {@link MAX_PINGS_PER_REQUEST}. */
export const pingBody = z.strictObject({
  pings: z
    .array(ping)
    .min(1)
    .max(MAX_PINGS_PER_REQUEST)
    .transform((pings) =>
      pings.map((item) => {
        const rest = { ...item };
        delete rest.courierId;
        return rest;
      }),
    ),
});

export const nearestQuery = z.strictObject({
  lat: z.coerce.number().min(-90).max(90),
  lng: z.coerce.number().min(-180).max(180),
  radiusM: z.coerce.number().int().positive(),
  limit: z.coerce.number().int().positive().default(10),
  serviceArea: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{0,63}$/)
    .optional(),
});

/** A tracking token as issued: 43 characters of base64url. */
export const TOKEN_PARAM = /^[A-Za-z0-9_-]{43}$/;
