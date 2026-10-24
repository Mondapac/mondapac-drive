import { DeliveryDomainError } from './errors.js';
import type { MarketDeliverySettings } from './market-settings.js';

export type DeliveryMode = 'on_demand' | 'scheduled';

/** The time span the customer was promised, as UTC instants. */
export interface DeliveryWindow {
  readonly start: Date;
  readonly end: Date;
}

export function assertWindowAllowed(
  window: DeliveryWindow,
  now: Date,
  scheduling: MarketDeliverySettings['scheduling'],
): void {
  const minutes = (ms: number) => ms / 60_000;
  if (minutes(window.end.getTime() - window.start.getTime()) < scheduling.minWindowMinutes) {
    throw new DeliveryDomainError(
      'schedule.window-too-short',
      `A delivery window must be at least ${scheduling.minWindowMinutes} minutes`,
    );
  }
  if (minutes(window.start.getTime() - now.getTime()) < scheduling.minLeadMinutes) {
    throw new DeliveryDomainError(
      'schedule.too-soon',
      `A scheduled delivery must start at least ${scheduling.minLeadMinutes} minutes from now`,
    );
  }
  if (minutes(window.start.getTime() - now.getTime()) > scheduling.maxDaysAhead * 24 * 60) {
    throw new DeliveryDomainError(
      'schedule.too-far',
      `A scheduled delivery can be booked at most ${scheduling.maxDaysAhead} days ahead`,
    );
  }
}
