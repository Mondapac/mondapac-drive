import { z } from 'zod';

/**
 * Response types of the API, parsed at the edge so that the screens only see checked data.
 * Objects are not strict: the API may add fields without breaking an installed app.
 */

/** Minor units as decimal text, as every amount in the API (JSON has no 64-bit integer). */
export const money = z.object({
  amount: z.string().regex(/^-?(0|[1-9][0-9]{0,15})$/),
  currency: z.string().regex(/^[A-Z]{3}$/),
});
export type Money = z.infer<typeof money>;

export const TEMPERATURES = ['ambient', 'chilled', 'frozen'] as const;
export type Temperature = (typeof TEMPERATURES)[number];

export const VEHICLE_TYPES = ['bicycle', 'motorbike', 'car', 'van'] as const;

/** The statuses of modules/delivery (domain/delivery-status.ts). */
export const DELIVERY_STATUSES = [
  'SCHEDULED',
  'DISPATCHING',
  'ASSIGNED',
  'AT_PICKUP',
  'PICKED_UP',
  'AT_DROPOFF',
  'DELIVERED',
  'DELIVERY_FAILED',
  'RETURNING',
  'RETURNED',
  'CANCELLED',
] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

const point = z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) });
export type GeoPoint = z.infer<typeof point>;

const coldChainLimit = z.object({ maxCelsius: z.number() });

/** What the courier's Market says, so the app holds no Market value of its own. */
export const courierSettings = z.object({
  marketId: z.string().min(2).max(8),
  locale: z.string().min(2),
  currency: z.string().regex(/^[A-Z]{3}$/),
  distanceUnit: z.enum(['km', 'mi']),
  supportPhone: z.string().min(3),
  offerAcceptSeconds: z.number().int().positive(),
  coldChain: z.object({ chilled: coldChainLimit, frozen: coldChainLimit }),
});
export type CourierSettings = z.infer<typeof courierSettings>;
export type ColdChainLimits = CourierSettings['coldChain'];

/** The courier's session: the bearer token and the Market it was opened in. */
export const courierSession = z.object({
  token: z.string().min(16),
  marketId: z.string().min(2).max(8),
});
export type CourierSession = z.infer<typeof courierSession>;

export const SHIFT_STATES = ['offline', 'online', 'on_delivery', 'paused'] as const;
export type ShiftState = (typeof SHIFT_STATES)[number];

export const courierStatus = z.object({
  shift: z.enum(SHIFT_STATES),
  activeDeliveryId: z.string().min(1).nullable(),
});
export type CourierStatus = z.infer<typeof courierStatus>;

const offerStop = z.object({ address: z.string(), point });

export const offer = z.object({
  id: z.string().min(1),
  deliveryId: z.string().min(1),
  expiresAt: z.iso.datetime({ offset: true }),
  pickup: offerStop,
  dropoff: offerStop,
  distanceMetres: z.number().int().nonnegative(),
  /** Absent until dispatch quotes the courier's pay (payouts rate card). */
  earnings: money.optional(),
  temperature: z.enum(TEMPERATURES),
});
export type Offer = z.infer<typeof offer>;

export const currentOffer = z.object({ offer: offer.nullable() });

export const offerAccepted = z.object({ deliveryId: z.string().min(1) });

const stop = z.object({
  address: z.string(),
  postcode: z.string(),
  /** Absent when the stop could not be geocoded; the app then navigates by address. */
  point: point.optional(),
  contactName: z.string(),
  contactPhone: z.string(),
  notes: z.string().optional(),
});
export type Stop = z.infer<typeof stop>;

/** The part of `GET /delivery/deliveries/:id` the courier needs. */
export const job = z.object({
  id: z.string().min(1),
  status: z.enum(DELIVERY_STATUSES),
  pickup: stop,
  dropoff: stop,
  parcel: z.object({
    weightGrams: z.number(),
    volumeLitres: z.number(),
    temperature: z.enum(TEMPERATURES),
  }),
  courierId: z.string().optional(),
});
export type Job = z.infer<typeof job>;

export const proofPhoto = z.object({ photoRef: z.string().min(1).max(300) });

export const earningsSummary = z.object({
  today: money,
  week: money,
  deliveriesToday: z.number().int().nonnegative(),
});
export type EarningsSummary = z.infer<typeof earningsSummary>;

export const apiError = z.object({ code: z.string(), details: z.unknown().optional() });

/** Inputs the courier types, checked before anything is sent. */
export const signInInput = z.object({
  email: z.email().max(254),
  password: z.string().min(1).max(256),
});
export type SignInInput = z.infer<typeof signInInput>;

/** The PIN length is the Market's (4 in AU, 6 in ZZ); the server checks it, the app takes 4 to 8. */
export const pinInput = z.string().regex(/^[0-9]{4,8}$/);

/** The same range the delivery API accepts (presentation/delivery.schemas.ts). */
export const temperatureReading = z.number().min(-40).max(60);

export const FAILURE_REASONS = [
  'customer_unavailable',
  'address_not_found',
  'access_issue',
  'refused',
  'damaged',
  'cold_chain_breach',
  'other',
] as const;
export type FailureReason = (typeof FAILURE_REASONS)[number];

/** The answer of identity's courier sign-in (`POST /identity/courier/sign-in`). */
export const courierSignedIn = z.object({
  code: z.literal('signed-in'),
  token: z.string().min(16),
});

/** A location fix as tracking takes it; the courier is the bearer session's, never a field. */
export interface LocationPing {
  readonly lat: number;
  readonly lng: number;
  readonly accuracyM: number;
  readonly headingDeg?: number;
  readonly speedKmh?: number;
  readonly recordedAt: string;
}
