import { err, ok, Temporal, type Id, type Result } from '@mondapac-drive/shared-kernel';
import type { LivePosition } from './live-position';
import {
  phaseOf,
  showsCourierToCustomer,
  type TrackedDelivery,
  type TrackingPhase,
} from './tracked-delivery';
import type { TrackingSettings } from './tracking-settings';

/**
 * A customer tracking link. Only the hash of its token is stored; the token itself is shown once,
 * to the caller that issued it. A link ends at `expiresAt` or when its delivery ends.
 */
export interface TrackingLink {
  readonly tokenHash: string;
  readonly deliveryId: Id<'Delivery'>;
  readonly createdAt: Temporal.Instant;
  readonly expiresAt: Temporal.Instant;
}

export function issueTrackingLink(
  settings: TrackingSettings,
  deliveryId: Id<'Delivery'>,
  tokenHash: string,
  now: Temporal.Instant,
): TrackingLink {
  return {
    tokenHash,
    deliveryId,
    createdAt: now,
    expiresAt: now.add({ hours: settings.trackingLinkTtlHours }),
  };
}

/**
 * Everything a tracking link shows: the phase and, from pickup until drop-off, the ETA and the
 * courier's position rounded to about 11 metres. Never the courier's id, name or trail, the
 * addresses or anything else of the delivery.
 */
export type CustomerView =
  | { readonly phase: 'awaiting_courier' | 'heading_to_pickup' }
  | {
      readonly phase: 'on_the_way' | 'arriving';
      readonly etaSeconds?: number;
      readonly courier?: {
        readonly lat: number;
        readonly lng: number;
        readonly recordedAt: Temporal.Instant;
      };
    };

export type LinkRefusal =
  | { readonly code: 'tracking.link-not-found' }
  | { readonly code: 'tracking.link-expired' }
  | { readonly code: 'tracking.ended' };

/** Four decimal places: about 11 metres, enough to watch a courier approach. */
const roundCoordinate = (value: number): number => Math.round(value * 10_000) / 10_000;

/** Whether the link is still open at `now`; checked before anything of the delivery is read. */
export function checkLinkOpen(
  link: TrackingLink,
  now: Temporal.Instant,
): Result<TrackingLink, LinkRefusal> {
  if (Temporal.Instant.compare(now, link.expiresAt) >= 0) {
    return err({ code: 'tracking.link-expired' });
  }
  return ok(link);
}

/**
 * Whether the customer may see the courier's position: not while the courier also carries
 * another delivery past pickup, since the courier may then be at that other customer's door
 * (security review of tracking, M3). The ETA is still shown.
 */
export function mayShowCourierPosition(
  delivery: TrackedDelivery,
  courierDeliveries: readonly TrackedDelivery[],
): boolean {
  return !courierDeliveries.some(
    (other) =>
      other.deliveryId !== delivery.deliveryId &&
      other.endedAt === undefined &&
      showsCourierToCustomer(phaseOf(other.status)),
  );
}

export function customerView(
  delivery: TrackedDelivery,
  courier: LivePosition | undefined,
  etaSeconds: number | undefined,
  showPosition = true,
): Result<CustomerView, LinkRefusal> {
  const phase: TrackingPhase = phaseOf(delivery.status);
  if (phase === 'ended' || delivery.endedAt !== undefined) return err({ code: 'tracking.ended' });
  if (!showsCourierToCustomer(phase)) {
    return ok({ phase: phase as 'awaiting_courier' | 'heading_to_pickup' });
  }
  // Only the assigned courier's position, never another courier's.
  const shown = courier !== undefined && courier.courierId === delivery.courierId;
  return ok({
    phase: phase as 'on_the_way' | 'arriving',
    ...(shown && etaSeconds !== undefined ? { etaSeconds } : {}),
    ...(shown && showPosition
      ? {
          courier: {
            lat: roundCoordinate(courier.point.lat),
            lng: roundCoordinate(courier.point.lng),
            recordedAt: courier.recordedAt,
          },
        }
      : {}),
  });
}
