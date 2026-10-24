import { Temporal } from '@mondapac-drive/shared-kernel';
import { z } from 'zod';
import { DELIVERY_STATUSES } from '../domain/delivery-status';
import { TEMPERATURES } from '../domain/parcel';
import { VEHICLE_TYPES } from '../domain/vehicle';

const point = z.strictObject({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});

const postcode = z.string().regex(/^[0-9A-Za-z -]{3,10}$/);

const window = z
  .strictObject({ start: z.iso.datetime({ offset: true }), end: z.iso.datetime({ offset: true }) })
  .transform((w) => ({
    start: Temporal.Instant.from(w.start),
    end: Temporal.Instant.from(w.end),
  }));

const parcel = z.strictObject({
  weightGrams: z.number().int().positive(),
  volumeLitres: z.number().int().positive(),
  temperature: z.enum(TEMPERATURES),
});

const shared = {
  parcel,
  mode: z.enum(['on_demand', 'scheduled']),
  window: window.optional(),
  vehicle: z.enum(VEHICLE_TYPES).optional(),
};

export const quoteBody = z.strictObject({
  pickup: z.strictObject({ postcode, point }),
  dropoff: z.strictObject({ postcode, point }),
  ...shared,
});

const stop = z.strictObject({
  address: z.string().min(3).max(300),
  postcode,
  point,
  contactName: z.string().min(1).max(120),
  contactPhone: z.string().regex(/^\+?[0-9 ]{6,20}$/),
  notes: z.string().max(500).optional(),
});

/** A booking: the merchant is the API key's, never a field. */
export const createDeliveryBody = z.strictObject({
  externalReference: z.string().min(1).max(128),
  pickup: stop,
  dropoff: stop,
  /** Minor units as decimal text, as every amount in this API (JSON has no 64-bit integer). */
  expectedTotal: z
    .string()
    .regex(/^(0|[1-9][0-9]{0,15})$/)
    .transform((value) => BigInt(value))
    .optional(),
  ...shared,
});

const proof = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('pin'), pinMatched: z.literal(true) }),
  z.strictObject({ kind: z.literal('photo'), photoRef: z.string().min(1).max(300) }),
]);

const reason = z.string().max(500);

/** What a courier reports on its own assignment: never a courier id, which is the actor's. */
export const courierReportBody = z.strictObject({
  type: z.enum([
    'arrived_at_pickup',
    'picked_up',
    'arrived_at_dropoff',
    'delivered',
    'delivery_failed',
    'return_started',
    'returned',
  ]),
  temperatureCelsius: z.number().min(-40).max(60).optional(),
  proof: proof.optional(),
  reason: reason.optional(),
});

/** A dispatcher's step: the courier is the courier's identity account id (a UUID). */
export const dispatchBody = z.strictObject({
  type: z.enum(['dispatch_opened', 'courier_assigned', 'courier_unassigned']),
  courierId: z.uuid().optional(),
  vehicle: z.enum(VEHICLE_TYPES).optional(),
  reason: reason.optional(),
});

/** A cancellation always has a reason. */
export const cancelBody = z.strictObject({ reason: reason.min(1) });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const queryText = (max: number) => z.string().min(1).max(max);

/**
 * The operations panel's delivery list query: `status` (comma-separated, each a status),
 * `merchantId`, `courierId`, `before` (the `next` of the previous page) and `limit`. A query
 * value arrives as text; a repeated key arrives as an array and is refused.
 */
export const deliveryListQuery = z.strictObject({
  status: queryText(200)
    .transform((value) => value.split(','))
    .pipe(z.array(z.enum(DELIVERY_STATUSES)).min(1).max(DELIVERY_STATUSES.length))
    .optional(),
  merchantId: queryText(64).regex(UUID).optional(),
  courierId: queryText(64).regex(UUID).optional(),
  before: queryText(36).regex(UUID).optional(),
  limit: queryText(3)
    .regex(/^[1-9][0-9]{0,2}$/)
    .transform(Number)
    .pipe(z.number().max(100))
    .optional(),
});
