import type { Temporal } from '@mondapac-drive/shared-kernel';
import type { DeliveryHistoryEntry } from './delivery';
import type { DeliveryStatus } from './delivery-status';

/** Whole seconds a courier spent at each stop, waiting for the parcel or the recipient. */
export interface WaitingSeconds {
  readonly pickup: number;
  readonly dropoff: number;
}

const WAITING_STATUSES: Readonly<Partial<Record<DeliveryStatus, keyof WaitingSeconds>>> = {
  AT_PICKUP: 'pickup',
  AT_DROPOFF: 'dropoff',
};

/**
 * The time the delivery spent in AT_PICKUP and in AT_DROPOFF, from its history: from the step
 * that entered the status to the next step. The time belongs to the courier assigned now: an
 * assignment starts the count again, so a courier unassigned at the pickup takes their waiting
 * with them (Hassan L2). A stay still open counts up to `now`. Payouts pays waiting time from it
 * in a later wave; arrivals are the courier's own reports, so payouts must bound it first.
 */
export function waitingSecondsOf(
  history: readonly DeliveryHistoryEntry[],
  now: Temporal.Instant,
): WaitingSeconds {
  const totals = { pickup: 0, dropoff: 0 };
  let open: { stop: keyof WaitingSeconds; since: Temporal.Instant } | undefined;
  const close = (at: Temporal.Instant) => {
    if (open === undefined) return;
    const ms = at.epochMilliseconds - open.since.epochMilliseconds;
    totals[open.stop] += Math.max(0, ms);
    open = undefined;
  };
  for (const entry of history) {
    close(entry.at);
    if (entry.type === 'courier_assigned') {
      totals.pickup = 0;
      totals.dropoff = 0;
    }
    const stop = WAITING_STATUSES[entry.status];
    if (stop !== undefined) open = { stop, since: entry.at };
  }
  close(now);
  return {
    pickup: Math.floor(totals.pickup / 1000),
    dropoff: Math.floor(totals.dropoff / 1000),
  };
}
