import { z } from 'zod';
import { DELIVERY_EVENT_TYPES } from '../domain/delivery-status.js';
import { TEMPERATURES } from '../domain/parcel.js';
import { VEHICLE_TYPES } from '../domain/vehicle.js';

const point = z.strictObject({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});

const postcode = z.string().regex(/^[0-9A-Za-z -]{3,10}$/);

const window = z
  .strictObject({ start: z.iso.datetime({ offset: true }), end: z.iso.datetime({ offset: true }) })
  .transform((w) => ({ start: new Date(w.start), end: new Date(w.end) }));

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

export const createDeliveryBody = z.strictObject({
  merchantId: z.string().min(1).max(64),
  externalReference: z.string().min(1).max(128),
  pickup: stop,
  dropoff: stop,
  expectedTotal: z.number().int().nonnegative().optional(),
  ...shared,
});

export const deliveryEventBody = z.strictObject({
  type: z.enum(DELIVERY_EVENT_TYPES),
  courierId: z.string().min(1).max(64).optional(),
  vehicle: z.enum(VEHICLE_TYPES).optional(),
  temperatureCelsius: z.number().min(-40).max(60).optional(),
  proof: z
    .discriminatedUnion('kind', [
      z.strictObject({ kind: z.literal('pin'), pinMatched: z.literal(true) }),
      z.strictObject({ kind: z.literal('photo'), photoRef: z.string().min(1).max(300) }),
    ])
    .optional(),
  reason: z.string().max(500).optional(),
});
