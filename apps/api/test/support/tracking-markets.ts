import type { GeoPoint, Id, MarketContext, Result } from '@mondapac-drive/shared-kernel';
import { Temporal } from '@mondapac-drive/shared-kernel';
import { FixedClock } from '@mondapac-drive/shared-kernel/testing';
import type { TrackingRepository } from '../../src/modules/tracking/application/ports';
import { straightLineMetres } from '../../src/modules/tracking/domain/geo-distance';
import type { RoutingProvider } from '../../src/platform/routing';
import { ConfigTrackingSettingsProvider } from '../../src/modules/tracking/infrastructure/config-tracking-settings.provider';
import type { Breadcrumb, PurgeCutoffs } from '../../src/modules/tracking/domain/breadcrumb';
import type { TrackedDelivery } from '../../src/modules/tracking/domain/tracked-delivery';
import type { TrackingLink } from '../../src/modules/tracking/domain/tracking-link';
import { loadMarketConfigs } from '../../src/platform/market-config/market-config';
import { MarketRegistry } from '../../src/platform/market-config/market-registry';
import type { UnitOfWork } from '../../src/platform/unit-of-work/unit-of-work';
import { StaleAggregateError } from '../../src/platform/unit-of-work/errors';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from './test-config';

/** The tracking settings of the real AU file and the synthetic ZZ market (other limits). */
export const trackingSettings = new ConfigTrackingSettingsProvider(
  new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS)),
);

export const START = Temporal.Instant.from('2026-11-02T00:00:00Z');
export const newClock = () => new FixedClock(START);

/** Routing at 30 km/h in a straight line, counting its calls. */
export function fakeRouting(): RoutingProvider & { calls: number } {
  const fake = {
    calls: 0,
    route(_market: MarketContext, from: GeoPoint, to: GeoPoint) {
      fake.calls += 1;
      const distanceMetres = straightLineMetres(from, to);
      return Promise.resolve({
        distanceMetres,
        durationSeconds: Math.round(distanceMetres / (30_000 / 3600)),
        source: 'straight_line' as const,
      });
    },
    matrix: () => Promise.reject(new Error('not used by tracking')),
    geocode: () => Promise.reject(new Error('not used by tracking')),
  };
  return fake;
}

/** A unit of work that just runs the work: for application tests on in-memory ports. */
export const directUnitOfWork: UnitOfWork = {
  run: <T, E>(_market: MarketContext, work: () => Promise<Result<T, E>>) => work(),
  runOnce: () => Promise.reject(new Error('not used by tracking')),
};

const key = (market: MarketContext, id: string) => `${market.marketId}:${id}`;

/** {@link TrackingRepository} in memory, with the same version check as the Prisma one. */
export class InMemoryTrackingRepository implements TrackingRepository {
  readonly deliveries = new Map<string, TrackedDelivery>();
  readonly breadcrumbs = new Map<string, Breadcrumb[]>();
  readonly links = new Map<string, TrackingLink>();

  findDelivery(market: MarketContext, deliveryId: Id<'Delivery'>) {
    return Promise.resolve(this.deliveries.get(key(market, deliveryId)));
  }

  saveDelivery(market: MarketContext, delivery: TrackedDelivery) {
    const stored = this.deliveries.get(key(market, delivery.deliveryId));
    if ((stored?.version ?? 0) !== delivery.version - 1) {
      return Promise.reject(new StaleAggregateError('tracked-delivery', delivery.deliveryId));
    }
    this.deliveries.set(key(market, delivery.deliveryId), delivery);
    return Promise.resolve();
  }

  activeDeliveriesOf(market: MarketContext, courierId: string) {
    return Promise.resolve(
      [...this.deliveries.entries()]
        .filter(([k, d]) => k.startsWith(`${market.marketId}:`) && d.courierId === courierId)
        .filter(([, d]) => d.endedAt === undefined)
        .map(([, d]) => d),
    );
  }

  appendBreadcrumbs(market: MarketContext, crumbs: readonly Breadcrumb[]) {
    for (const crumb of crumbs) {
      const trail = this.breadcrumbs.get(key(market, crumb.deliveryId)) ?? [];
      if (!trail.some((c) => Temporal.Instant.compare(c.recordedAt, crumb.recordedAt) === 0)) {
        trail.push(crumb);
      }
      this.breadcrumbs.set(key(market, crumb.deliveryId), trail);
    }
    return Promise.resolve();
  }

  trailOf(market: MarketContext, deliveryId: Id<'Delivery'>, limit: number) {
    return Promise.resolve((this.breadcrumbs.get(key(market, deliveryId)) ?? []).slice(0, limit));
  }

  insertLink(market: MarketContext, link: TrackingLink) {
    this.links.set(key(market, link.tokenHash), link);
    return Promise.resolve();
  }

  findLink(market: MarketContext, tokenHash: string) {
    return Promise.resolve(this.links.get(key(market, tokenHash)));
  }

  purge(market: MarketContext, cutoffs: PurgeCutoffs) {
    const before = (a: Temporal.Instant, b: Temporal.Instant) => Temporal.Instant.compare(a, b) < 0;
    let breadcrumbs = 0;
    let deliveries = 0;
    let links = 0;
    for (const [k, trail] of this.breadcrumbs) {
      if (!k.startsWith(`${market.marketId}:`)) continue;
      const kept = trail.filter((c) => !before(c.recordedAt, cutoffs.breadcrumbsBefore));
      breadcrumbs += trail.length - kept.length;
      this.breadcrumbs.set(k, kept);
    }
    for (const [k, d] of this.deliveries) {
      if (
        k.startsWith(`${market.marketId}:`) &&
        d.endedAt &&
        before(d.endedAt, cutoffs.deliveriesEndedBefore)
      ) {
        this.deliveries.delete(k);
        deliveries += 1;
      }
    }
    for (const [k, l] of this.links) {
      if (k.startsWith(`${market.marketId}:`) && before(l.expiresAt, cutoffs.linksExpiredBefore)) {
        this.links.delete(k);
        links += 1;
      }
    }
    return Promise.resolve({ breadcrumbs, deliveries, links });
  }
}
