import type { GeoPoint, Id, Temporal } from '@mondapac-drive/shared-kernel';
import type { TrackingSettings } from './tracking-settings';

/** One point of a delivery's trail, recorded while a courier carries it. */
export interface Breadcrumb {
  readonly deliveryId: Id<'Delivery'>;
  readonly courierId: string;
  readonly point: GeoPoint;
  readonly accuracyMetres: number;
  readonly recordedAt: Temporal.Instant;
}

/** What the retention job removes, by Market setting. */
export interface PurgeCutoffs {
  /** Breadcrumbs recorded before this instant. */
  readonly breadcrumbsBefore: Temporal.Instant;
  /** Tracked deliveries that ended before this instant (their trail is gone by then). */
  readonly deliveriesEndedBefore: Temporal.Instant;
  /** Tracking links that expired before this instant. */
  readonly linksExpiredBefore: Temporal.Instant;
}

/**
 * The cutoffs of the retention job: a trail is kept `breadcrumbRetentionDays`, and so is the
 * record of an ended delivery; a link is deleted once it has expired, since nobody can use it.
 */
export function purgeCutoffs(settings: TrackingSettings, now: Temporal.Instant): PurgeCutoffs {
  const retention = now.subtract({ hours: settings.breadcrumbRetentionDays * 24 });
  return {
    breadcrumbsBefore: retention,
    deliveriesEndedBefore: retention,
    linksExpiredBefore: now,
  };
}
