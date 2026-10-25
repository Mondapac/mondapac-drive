import type { Id, Temporal } from '@mondapac-drive/shared-kernel';
import { FleetDomainError } from './errors';

/**
 * Fleet's view of one delivery a courier carries (handoff 31), kept from delivery's events: who
 * carries it now, since when, and whether it is over. A courier with an open job is busy:
 * dispatch offers them no other work and they cannot go offline. A finished job keeps no courier,
 * so the row holds no personal data once the delivery is done.
 */
export interface CourierJob {
  readonly deliveryId: Id<'Delivery'>;
  /** The identity account of the courier who carries it now; absent when nobody does. */
  readonly courierAccountId?: string;
  /** When fleet heard that this courier was given it; set exactly when a courier is. */
  readonly assignedAt?: Temporal.Instant;
  /** Delivered, returned or cancelled: the job never opens again. */
  readonly ended: boolean;
  /** The last delivery aggregate version applied: an older or repeated event changes nothing. */
  readonly deliveryVersion: number;
}

/** What one delivery event says about the job. */
export interface DeliveryReport {
  readonly deliveryId: Id<'Delivery'>;
  /** The event's aggregate version: one per delivery change. */
  readonly deliveryVersion: number;
  /** Delivery's lower-case status code after the change (`picked-up`, `cancelled`). */
  readonly status: string;
  /** The courier after the change; null when nobody carries the delivery. */
  readonly courierAccountId: string | null;
}

/**
 * The statuses after which the courier is free again. A failed delivery still has the parcel on
 * board until it is returned, so only RETURNED ends it.
 */
export const JOB_ENDING_STATUSES: readonly string[] = ['delivered', 'returned', 'cancelled'];

/** The longest identity account id fleet stores (`fleet.couriers.actor_id`). */
const MAX_ACCOUNT_ID_LENGTH = 64;

/**
 * Applies one delivery event to the job: a courier on it holds it from now, no courier (an
 * unassign, also the first half of a reassignment) frees it, and an ending status closes it for
 * good. Answers `current` itself when nothing changes, so the caller writes nothing: an event at
 * or below the applied version, or any event after the job ended.
 */
export function followJob(
  current: CourierJob | undefined,
  report: DeliveryReport,
  now: Temporal.Instant,
): CourierJob {
  if (!Number.isInteger(report.deliveryVersion) || report.deliveryVersion < 1) {
    throw new FleetDomainError('fleet.job.version-invalid', 'A delivery version is 1 or more');
  }
  const courier = report.courierAccountId;
  if (courier !== null && (courier.length === 0 || courier.length > MAX_ACCOUNT_ID_LENGTH)) {
    throw new FleetDomainError('fleet.job.courier-invalid', 'The courier id is not valid');
  }
  if (current !== undefined) {
    if (current.deliveryId !== report.deliveryId) {
      throw new FleetDomainError('fleet.job.delivery-mismatch', 'The event is for another job');
    }
    if (current.ended || report.deliveryVersion <= current.deliveryVersion) return current;
  }
  const ended = JOB_ENDING_STATUSES.includes(report.status);
  const carrier = ended ? null : courier;
  // The same courier keeps the time they were given it; a new one starts now.
  const heldSince =
    carrier !== null && current?.courierAccountId === carrier ? current.assignedAt : undefined;
  return {
    deliveryId: report.deliveryId,
    ...(carrier === null
      ? {}
      : {
          courierAccountId: carrier,
          assignedAt: heldSince ?? now,
        }),
    ended,
    deliveryVersion: report.deliveryVersion,
  };
}

/**
 * The delivery a courier is on now: of their open jobs, the one they were given first (then by
 * delivery id), so the answer is stable while a dispatcher's extra assignment waits behind it.
 */
export function activeDeliveryOf(jobs: readonly CourierJob[]): Id<'Delivery'> | undefined {
  const open = jobs.filter(
    (job): job is CourierJob & { readonly assignedAt: Temporal.Instant } =>
      !job.ended && job.courierAccountId !== undefined && job.assignedAt !== undefined,
  );
  open.sort(
    (a, b) =>
      a.assignedAt.epochMilliseconds - b.assignedAt.epochMilliseconds ||
      (a.deliveryId < b.deliveryId ? -1 : a.deliveryId > b.deliveryId ? 1 : 0),
  );
  return open[0]?.deliveryId;
}
