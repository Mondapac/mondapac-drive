import { parsePlainText, Temporal } from '@mondapac-drive/shared-kernel';
import { z } from 'zod';
import { TEMPERATURES } from '../domain/parcel';
import { VEHICLE_TYPES } from '../domain/vehicle';

/**
 * Free text a person reads (a stop's address, contact, notes, a reason): no control, bidi or
 * other invisible formatting character, which could make a panel or the courier app show it as
 * something else (Hassan, WP2 review). The kernel's plain-text rule, as identity's names.
 */
const plainText = (schema: z.ZodString) =>
  schema.refine((value) => parsePlainText(value).ok, {
    message: 'must not contain control or invisible formatting characters',
  });

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

const address = plainText(z.string().min(3).max(300));

/** A quoted stop: its point, or an address to geocode (with the postcode), or both. */
const quoteStop = z
  .strictObject({ postcode, point: point.optional(), address: address.optional() })
  .refine((stop) => stop.point !== undefined || stop.address !== undefined, {
    message: 'give the point or the address',
    path: ['point'],
  });

export const quoteBody = z.strictObject({
  pickup: quoteStop,
  dropoff: quoteStop,
  ...shared,
});

/** A booked stop; without a point it is geocoded from the address and postcode. */
const stop = z.strictObject({
  address,
  postcode,
  point: point.optional(),
  contactName: plainText(z.string().min(1).max(120)),
  contactPhone: z.string().regex(/^\+?[0-9 ]{6,20}$/),
  notes: plainText(z.string().max(500)).optional(),
});

/** A booking: the merchant is the API key's, never a field. */
export const createDeliveryBody = z.strictObject({
  externalReference: plainText(z.string().min(1).max(128)),
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
  z.strictObject({ kind: z.literal('photo'), photoRef: plainText(z.string().min(1).max(300)) }),
]);

const reason = plainText(z.string().max(500));

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
export const cancelBody = z.strictObject({ reason: plainText(z.string().min(1).max(500)) });
