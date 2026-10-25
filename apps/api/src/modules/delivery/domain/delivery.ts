import type { GeoPoint, Id, MarketId, Temporal } from '@mondapac-drive/shared-kernel';
import { TRANSITIONS, type DeliveryEventType, type DeliveryStatus } from './delivery-status';
import { DeliveryDomainError } from './errors';
import type { DeliveryReasonCode } from './reason-codes';
import type { MarketDeliverySettings } from './market-settings';
import { needsColdChain, type Parcel } from './parcel';
import type { DeliveryQuote } from './pricing';
import type { DeliveryMode, DeliveryWindow } from './schedule';
import type { VehicleType } from './vehicle';

export interface Stop {
  readonly address: string;
  readonly postcode: string;
  readonly point: GeoPoint;
  /** The suburb the geocoder named for the address; absent when the stop came with a point. */
  readonly suburb?: string;
  readonly contactName: string;
  readonly contactPhone: string;
  readonly notes?: string;
}

/**
 * How the courier proved the hand-over, as the server checked it: the recipient's PIN (never
 * stored, only that it matched), or a proof photo of this delivery (its id).
 */
export type ProofOfDelivery =
  { readonly kind: 'pin' } | { readonly kind: 'photo'; readonly photoRef: string };

/** What a courier, a dispatcher or the system reports. Fields depend on the event type. */
export interface DeliveryEventInput {
  readonly type: DeliveryEventType;
  readonly courierId?: string;
  readonly vehicle?: VehicleType;
  readonly temperatureCelsius?: number;
  readonly proof?: ProofOfDelivery;
  readonly reason?: string;
  /**
   * The reason as a code, for the outbox event: who cancelled, or why a courier was unassigned.
   * Set by the use case, never by the caller; not stored in the history.
   */
  readonly reasonCode?: DeliveryReasonCode;
}

export interface DeliveryHistoryEntry extends DeliveryEventInput {
  readonly status: DeliveryStatus;
  readonly at: Temporal.Instant;
}

/**
 * What needs a dispatcher's hand, outside the lifecycle: dispatch ran out of couriers, or (not
 * recorded yet) a cold-chain reading was over the limit. Not part of the version.
 */
export type DeliveryException = 'dispatch-exhausted' | 'cold-chain-breach';

/**
 * The statuses that need a dispatcher whatever the exception flag says: the delivery failed at
 * the door. A delivery needs attention when it has an exception or one of these statuses.
 */
export const ATTENTION_STATUSES: readonly DeliveryStatus[] = Object.freeze(['DELIVERY_FAILED']);

/** Whether a delivery needs a dispatcher's attention (the list's `attention` filter). */
export function needsAttention(delivery: Pick<DeliveryState, 'status' | 'exception'>): boolean {
  return delivery.exception !== undefined || ATTENTION_STATUSES.includes(delivery.status);
}

export interface DeliveryState {
  readonly id: Id<'Delivery'>;
  readonly marketId: MarketId;
  readonly merchantId: string;
  /** The merchant's own reference, such as a marketplace sub-order id. Unique per merchant. */
  readonly externalReference: string;
  readonly serviceAreaCode: string;
  readonly pickup: Stop;
  readonly dropoff: Stop;
  readonly parcel: Parcel;
  readonly mode: DeliveryMode;
  readonly window?: DeliveryWindow;
  readonly quote: DeliveryQuote;
  readonly status: DeliveryStatus;
  readonly courierId?: string;
  readonly exception?: DeliveryException;
  readonly history: readonly DeliveryHistoryEntry[];
  readonly createdAt: Temporal.Instant;
  /** Optimistic-concurrency version, bumped on every change. */
  readonly version: number;
}

export type NewDelivery = Omit<
  DeliveryState,
  'status' | 'history' | 'version' | 'courierId' | 'exception'
>;

export function createDelivery(input: NewDelivery): DeliveryState {
  const status: DeliveryStatus = input.mode === 'scheduled' ? 'SCHEDULED' : 'DISPATCHING';
  if (input.mode === 'scheduled' && !input.window) {
    throw new DeliveryDomainError(
      'schedule.window-required',
      'A scheduled delivery needs a window',
    );
  }
  if (input.mode === 'on_demand' && input.window) {
    throw new DeliveryDomainError(
      'schedule.window-not-allowed',
      'An on-demand delivery has no window',
    );
  }
  return {
    ...input,
    status,
    history:
      status === 'DISPATCHING' ? [{ type: 'dispatch_opened', status, at: input.createdAt }] : [],
    version: 1,
  };
}

/** Applies one event, enforcing the lifecycle, cold-chain readings and proof of delivery. */
export function applyDeliveryEvent(
  delivery: DeliveryState,
  event: DeliveryEventInput,
  at: Temporal.Instant,
  settings: Pick<MarketDeliverySettings, 'coldChain'>,
): DeliveryState {
  const transition = TRANSITIONS[event.type];
  if (!transition.from.includes(delivery.status)) {
    throw new DeliveryDomainError(
      'delivery.invalid-transition',
      `Cannot record ${event.type} while the delivery is ${delivery.status}`,
    );
  }

  let courierId = delivery.courierId;
  switch (event.type) {
    case 'courier_assigned':
      if (!event.courierId || !event.vehicle) {
        throw new DeliveryDomainError(
          'delivery.courier-required',
          'Assigning needs a courier and a vehicle',
        );
      }
      courierId = event.courierId;
      break;
    case 'courier_unassigned':
      courierId = undefined;
      break;
    case 'picked_up':
      assertColdChain(delivery.parcel, event, settings);
      break;
    case 'delivered':
      if (!event.proof) {
        throw new DeliveryDomainError(
          'delivery.proof-required',
          'Delivery needs a PIN or a photo as proof',
        );
      }
      assertColdChain(delivery.parcel, event, settings);
      break;
    case 'delivery_failed':
    case 'cancelled':
      if (!event.reason?.trim()) {
        throw new DeliveryDomainError('delivery.reason-required', `${event.type} needs a reason`);
      }
      if (
        event.type === 'cancelled' &&
        event.reasonCode !== 'merchant-cancelled' &&
        event.reasonCode !== 'operator-cancelled'
      ) {
        throw new DeliveryDomainError(
          'delivery.reason-required',
          'A cancel says who cancelled (merchant-cancelled or operator-cancelled)',
        );
      }
      break;
    default:
      break;
  }

  const clearsException = event.type === 'courier_assigned' || event.type === 'cancelled';
  const { exception, ...rest } = delivery;
  return {
    ...rest,
    ...(exception === undefined || clearsException ? {} : { exception }),
    status: transition.to,
    courierId,
    history: [...delivery.history, { ...event, status: transition.to, at }],
    version: delivery.version + 1,
  };
}

function assertColdChain(
  parcel: Parcel,
  event: DeliveryEventInput,
  settings: Pick<MarketDeliverySettings, 'coldChain'>,
): void {
  if (!needsColdChain(parcel.temperature)) return;
  const limit = settings.coldChain[parcel.temperature].maxCelsius;
  if (event.temperatureCelsius === undefined) {
    throw new DeliveryDomainError(
      'cold-chain.reading-required',
      `A ${parcel.temperature} parcel needs a temperature reading at ${event.type}`,
    );
  }
  if (event.temperatureCelsius > limit) {
    throw new DeliveryDomainError(
      'cold-chain.breach',
      `Reading ${event.temperatureCelsius}°C is above the ${limit}°C limit for a ${parcel.temperature} parcel`,
    );
  }
}
