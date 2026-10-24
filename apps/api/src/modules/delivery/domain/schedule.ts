import type { Temporal } from '@mondapac-drive/shared-kernel';
import { DeliveryDomainError } from './errors';
import type { MarketDeliverySettings } from './market-settings';

export type DeliveryMode = 'on_demand' | 'scheduled';

/** The time span the customer was promised, as instants. */
export interface DeliveryWindow {
  readonly start: Temporal.Instant;
  readonly end: Temporal.Instant;
}

export function assertWindowAllowed(
  window: DeliveryWindow,
  now: Temporal.Instant,
  scheduling: MarketDeliverySettings['scheduling'],
): void {
  const minutes = (from: Temporal.Instant, to: Temporal.Instant) =>
    (to.epochMilliseconds - from.epochMilliseconds) / 60_000;
  if (minutes(window.start, window.end) < scheduling.minWindowMinutes) {
    throw new DeliveryDomainError(
      'schedule.window-too-short',
      `A delivery window must be at least ${scheduling.minWindowMinutes} minutes`,
    );
  }
  if (minutes(now, window.start) < scheduling.minLeadMinutes) {
    throw new DeliveryDomainError(
      'schedule.too-soon',
      `A scheduled delivery must start at least ${scheduling.minLeadMinutes} minutes from now`,
    );
  }
  if (minutes(now, window.start) > scheduling.maxDaysAhead * 24 * 60) {
    throw new DeliveryDomainError(
      'schedule.too-far',
      `A scheduled delivery can be booked at most ${scheduling.maxDaysAhead} days ahead`,
    );
  }
}
