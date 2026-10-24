// The shapes the operations screens read from the API (Drive). Amounts are minor units as
// decimal text with an ISO 4217 currency; instants are ISO 8601 in UTC.

export interface MoneyBody {
  readonly amount: string;
  readonly currency: string;
}

export interface Merchant {
  readonly merchantId: string;
  readonly name: string;
  readonly state: 'active' | 'suspended';
  readonly stateChangedAt: string;
  readonly createdAt: string;
}

export interface ApiKey {
  readonly keyId: string;
  readonly label: string;
  readonly createdAt: string;
  readonly lastSeenAt: string;
  readonly expiresAt: string;
}

export interface ApiKeyIssued {
  readonly code: 'api-key.issued';
  readonly keyId: string;
  /** Shown once: the API never answers it again. */
  readonly key: string;
  readonly expiresAt: string;
}

export type CourierRow =
  | {
      readonly type: 'account';
      readonly accountId: string;
      readonly email: string;
      readonly displayName: string | null;
      readonly status: 'active' | 'disabled';
    }
  | {
      readonly type: 'invitation';
      readonly invitationId: string;
      readonly email: string;
      readonly status: 'pending' | 'expired';
      readonly createdAt: string;
      readonly expiresAt: string | null;
    };

export interface CourierPage {
  readonly items: readonly CourierRow[];
  readonly next: string | null;
}

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

export const VEHICLES = ['bicycle', 'motorbike', 'car', 'van'] as const;
export type Vehicle = (typeof VEHICLES)[number];

export interface DeliverySummary {
  readonly id: string;
  readonly merchantId: string;
  readonly externalReference: string;
  readonly serviceAreaCode: string;
  readonly mode: 'on_demand' | 'scheduled';
  readonly window?: { readonly start: string; readonly end: string };
  readonly status: DeliveryStatus;
  readonly courierId?: string;
  readonly vehicle: Vehicle;
  readonly temperature: 'ambient' | 'chilled' | 'frozen';
  readonly pickupPostcode: string;
  readonly dropoffPostcode: string;
  /** Rounded to 4 decimals; absent until the delivery API sends it (handoff 21). */
  readonly pickupPoint?: GeoPoint;
  readonly dropoffPoint?: GeoPoint;
  /** A state a dispatcher must act on, beside the status; absent or null when there is none. */
  readonly exception?: DeliveryException | null;
  readonly total: MoneyBody;
  readonly createdAt: string;
}

export interface GeoPoint {
  readonly lat: number;
  readonly lng: number;
}

export type DeliveryException = 'dispatch-exhausted' | 'cold-chain-breach';

export interface DeliveryPage {
  readonly items: readonly DeliverySummary[];
  readonly next: string | null;
}

export interface Stop {
  readonly address: string;
  readonly postcode: string;
  readonly point: { readonly lat: number; readonly lng: number };
  readonly contactName: string;
  readonly contactPhone: string;
  readonly notes?: string;
}

export interface HistoryEntry {
  readonly type: string;
  readonly status: DeliveryStatus;
  readonly at: string;
  readonly courierId?: string;
  readonly vehicle?: Vehicle;
  readonly temperatureCelsius?: number;
  readonly proof?: { readonly kind: 'pin' | 'photo' };
  readonly reason?: string;
}

export interface Delivery {
  readonly id: string;
  readonly merchantId: string;
  readonly externalReference: string;
  readonly serviceAreaCode: string;
  readonly pickup: Stop;
  readonly dropoff: Stop;
  readonly parcel: {
    readonly weightGrams: number;
    readonly volumeLitres: number;
    readonly temperature: 'ambient' | 'chilled' | 'frozen';
  };
  readonly mode: 'on_demand' | 'scheduled';
  readonly window?: { readonly start: string; readonly end: string };
  readonly quote: {
    readonly vehicle: Vehicle;
    readonly distanceMetres: number;
    readonly breakdown: {
      readonly base: MoneyBody;
      readonly distance: MoneyBody;
      readonly coldChain: MoneyBody;
      readonly scheduledDiscount: MoneyBody;
    };
    readonly total: MoneyBody;
    readonly tax: MoneyBody;
  };
  readonly status: DeliveryStatus;
  readonly courierId?: string;
  readonly history: readonly HistoryEntry[];
  readonly createdAt: string;
}

/** The statuses in which an admin may still cancel (before pickup). */
export const CANCELLABLE: ReadonlySet<DeliveryStatus> = new Set([
  'SCHEDULED',
  'DISPATCHING',
  'ASSIGNED',
  'AT_PICKUP',
]);

/** The list's filter tabs and the statuses each one asks for; `all` asks for none. */
export const DELIVERY_FILTERS = {
  all: [],
  waiting: ['DISPATCHING'],
  scheduled: ['SCHEDULED'],
  active: ['ASSIGNED', 'AT_PICKUP', 'PICKED_UP', 'AT_DROPOFF', 'RETURNING'],
  done: ['DELIVERED', 'DELIVERY_FAILED', 'RETURNED', 'CANCELLED'],
} as const satisfies Record<string, readonly DeliveryStatus[]>;
export type DeliveryFilter = keyof typeof DELIVERY_FILTERS;

export const PERMISSION = {
  deliveryView: 'delivery.delivery.view',
  deliveryDispatch: 'delivery.delivery.dispatch',
  deliveryCancel: 'delivery.delivery.cancel',
  merchantView: 'identity.merchant.view',
  merchantCreate: 'identity.merchant.create',
  merchantSuspend: 'identity.merchant.suspend',
  apiKeyIssue: 'identity.merchant-api-key.issue',
  courierView: 'identity.courier-account.view',
  courierInvite: 'identity.courier-account.invite',
  courierDisable: 'identity.courier-account.disable',
  mapView: 'tracking.map.view',
} as const;

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
