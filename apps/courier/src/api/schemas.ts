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

// Onboarding (handoff 38): the courier's own fleet profile and the Market's onboarding rules.

export const EMPLOYMENT_TYPES = ['employee', 'contractor'] as const;
export type EmploymentType = (typeof EMPLOYMENT_TYPES)[number];

export const COURIER_STANDINGS = ['applicant', 'active', 'suspended', 'offboarded'] as const;
export type CourierStanding = (typeof COURIER_STANDINGS)[number];

export const COLD_BOXES = ['none', 'insulated', 'refrigerated'] as const;
export type ColdBox = (typeof COLD_BOXES)[number];

export type VehicleType = (typeof VEHICLE_TYPES)[number];

export const DOCUMENT_STATUSES = ['submitted', 'verified', 'rejected', 'revoked'] as const;
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number];

const profileVehicle = z.object({
  id: z.string().min(1),
  type: z.enum(VEHICLE_TYPES),
  plate: z.string().nullable(),
  maxWeightGrams: z.number().int().positive(),
  maxVolumeLitres: z.number().int().positive(),
  coldBox: z.enum(COLD_BOXES),
  active: z.boolean(),
});
export type ProfileVehicle = z.infer<typeof profileVehicle>;

const profileDocument = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  vehicleId: z.string().nullable(),
  expiresAt: z.iso.datetime({ offset: true }).nullable(),
  status: z.enum(DOCUMENT_STATUSES),
  rejectionReason: z.string().nullable(),
});
export type ProfileDocument = z.infer<typeof profileDocument>;

/** The courier's fleet profile, as `GET /fleet/courier/me` and the fleet mutations answer it. */
export const courierProfile = z.object({
  id: z.string().min(1),
  status: z.enum(COURIER_STANDINGS),
  employmentType: z.enum(EMPLOYMENT_TYPES),
  coldChainCapable: z.boolean(),
  serviceAreaCode: z.string().min(1),
  vehicles: z.array(profileVehicle),
  documents: z.array(profileDocument),
});
export type CourierProfile = z.infer<typeof courierProfile>;

export const courierMe = z.object({ profile: courierProfile });

export const documentSubmitted = z.object({
  documentId: z.string().min(1),
  profile: courierProfile,
});

const documentRequirement = z.object({
  type: z.string().regex(/^[a-z][a-z0-9_]{1,39}$/),
  employmentTypes: z.array(z.enum(EMPLOYMENT_TYPES)).optional(),
  vehicleTypes: z.array(z.enum(VEHICLE_TYPES)).optional(),
  coldChainOnly: z.boolean(),
  perVehicle: z.boolean(),
  expires: z.boolean(),
});
export type DocumentRequirement = z.infer<typeof documentRequirement>;

/**
 * What a Market asks of a new courier, from `GET /fleet/courier/me/settings`: its service areas,
 * the vehicle types of its rate card (with their default capacity) and its required documents.
 */
export const onboardingRules = z.object({
  serviceAreas: z.array(z.object({ code: z.string().min(1) })).min(1),
  vehicleClasses: z
    .array(
      z.object({
        type: z.enum(VEHICLE_TYPES),
        maxWeightGrams: z.number().int().positive(),
        maxVolumeLitres: z.number().int().positive(),
        temperatures: z.array(z.enum(TEMPERATURES)),
      }),
    )
    .min(1),
  documents: z.array(documentRequirement),
  businessIdDocumentType: z.string().nullable(),
});
export type OnboardingRules = z.infer<typeof onboardingRules>;
export type VehicleClass = OnboardingRules['vehicleClasses'][number];

/** Payouts' hosted onboarding page for a contractor (`POST /payouts/courier/me/onboarding-link`). */
/** Hosts of the payment provider's hosted onboarding (Stripe Connect); anything else is refused. */
export const PAYOUT_ONBOARDING_HOSTS: readonly string[] = ['connect.stripe.com'];

export const payoutOnboardingLink = z.object({
  url: z
    .url({ protocol: /^https$/ })
    .refine((url) => PAYOUT_ONBOARDING_HOSTS.includes(new URL(url).hostname)),
  expiresAt: z.iso.datetime({ offset: true }),
});
export type PayoutOnboardingLink = z.infer<typeof payoutOnboardingLink>;

export const applyInput = z.object({
  employmentType: z.enum(EMPLOYMENT_TYPES),
  serviceAreaCode: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  coldChainCapable: z.boolean(),
});
export type ApplyInput = z.infer<typeof applyInput>;

/** A plate as fleet takes it: 1 to 10 letters or digits once spaces and dashes are dropped. */
export const plateInput = z
  .string()
  .transform((value) => value.replaceAll(/[\s-]/g, '').toUpperCase())
  .pipe(z.string().regex(/^[A-Z0-9]{1,10}$/));

export interface VehicleInput {
  readonly type: VehicleType;
  readonly plate?: string;
  readonly coldBox: ColdBox;
}

/** The kinds of a payouts ledger entry (modules/payouts domain/ledger.ts). */
export const LEDGER_ENTRY_KINDS = ['earning', 'tip', 'adjustment', 'reversal', 'payout'] as const;
export type LedgerEntryKind = (typeof LEDGER_ENTRY_KINDS)[number];

/** One line of the courier's ledger; a kind the app does not know yet still parses. */
export const ledgerEntry = z.object({
  id: z.string().min(1),
  kind: z.string().min(1),
  amount: money,
  tax: money,
  deliveryId: z.string().optional(),
  reason: z.string().optional(),
  occurredAt: z.iso.datetime({ offset: true }),
});
export type LedgerEntry = z.infer<typeof ledgerEntry>;

/** `GET /payouts/courier/me/balance`: what is owed (before and with tax), newest entries first. */
export const earningsBalance = z.object({
  balance: z.object({ amount: money, tax: money, total: money }),
  entries: z.array(ledgerEntry),
});
export type EarningsBalance = z.infer<typeof earningsBalance>;
