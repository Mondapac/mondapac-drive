import { Temporal, type Id, type MarketContext } from '@mondapac-drive/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import { StaleAggregateError } from '../../../platform/unit-of-work/errors';
import type { TrackingRepository } from '../application/ports';
import type { Breadcrumb, PurgeCutoffs } from '../domain/breadcrumb';
import type { TrackedDelivery, TrackedStatus } from '../domain/tracked-delivery';
import type { TrackingLink } from '../domain/tracking-link';
import type { VehicleType } from '../domain/vehicle';

const toDate = (instant: Temporal.Instant): Date => new Date(instant.epochMilliseconds);
const toInstant = (date: Date): Temporal.Instant =>
  Temporal.Instant.fromEpochMilliseconds(date.getTime());

interface DeliveryRow {
  readonly deliveryId: string;
  readonly status: string;
  readonly courierId: string | null;
  readonly vehicle: string | null;
  readonly pickupLat: number;
  readonly pickupLng: number;
  readonly dropoffLat: number;
  readonly dropoffLng: number;
  readonly startedAt: Date;
  readonly updatedAt: Date;
  readonly endedAt: Date | null;
  readonly version: number;
  readonly deliveryVersion: number | null;
}

const SELECT_DELIVERY = {
  deliveryId: true,
  status: true,
  courierId: true,
  vehicle: true,
  pickupLat: true,
  pickupLng: true,
  dropoffLat: true,
  dropoffLng: true,
  startedAt: true,
  updatedAt: true,
  endedAt: true,
  version: true,
  deliveryVersion: true,
} as const;

function readDelivery(row: DeliveryRow): TrackedDelivery {
  return {
    deliveryId: row.deliveryId as Id<'Delivery'>,
    status: row.status as TrackedStatus,
    ...(row.courierId === null ? {} : { courierId: row.courierId }),
    ...(row.vehicle === null ? {} : { vehicle: row.vehicle as VehicleType }),
    pickup: { lat: row.pickupLat, lng: row.pickupLng },
    dropoff: { lat: row.dropoffLat, lng: row.dropoffLng },
    startedAt: toInstant(row.startedAt),
    updatedAt: toInstant(row.updatedAt),
    ...(row.endedAt === null ? {} : { endedAt: toInstant(row.endedAt) }),
    version: row.version,
    ...(row.deliveryVersion === null ? {} : { deliveryVersion: row.deliveryVersion }),
  };
}

/**
 * {@link TrackingRepository} on the `tracking` schema, through the open unit's guarded client:
 * every `where` and every row pins the unit's Market and tenant.
 */
export class PrismaTrackingRepository implements TrackingRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findDelivery(market: MarketContext, deliveryId: Id<'Delivery'>) {
    const row = await this.prisma.tx(market).trackingDelivery.findFirst({
      where: { marketId: market.marketId, tenantId: market.tenantId, deliveryId },
      select: SELECT_DELIVERY,
    });
    return row === null ? undefined : readDelivery(row);
  }

  async saveDelivery(market: MarketContext, delivery: TrackedDelivery): Promise<void> {
    const tx = this.prisma.tx(market);
    const changes = {
      status: delivery.status,
      courierId: delivery.courierId ?? null,
      vehicle: delivery.vehicle ?? null,
      updatedAt: toDate(delivery.updatedAt),
      endedAt: delivery.endedAt === undefined ? null : toDate(delivery.endedAt),
      version: delivery.version,
      deliveryVersion: delivery.deliveryVersion ?? null,
    };
    if (delivery.version === 1) {
      const created = await tx.trackingDelivery.createMany({
        data: [
          {
            marketId: market.marketId,
            tenantId: market.tenantId,
            deliveryId: delivery.deliveryId,
            pickupLat: delivery.pickup.lat,
            pickupLng: delivery.pickup.lng,
            dropoffLat: delivery.dropoff.lat,
            dropoffLng: delivery.dropoff.lng,
            startedAt: toDate(delivery.startedAt),
            ...changes,
          },
        ],
        skipDuplicates: true,
      });
      if (created.count !== 1)
        throw new StaleAggregateError('tracked-delivery', delivery.deliveryId);
      return;
    }
    const updated = await tx.trackingDelivery.updateMany({
      where: {
        marketId: market.marketId,
        tenantId: market.tenantId,
        deliveryId: delivery.deliveryId,
        version: delivery.version - 1,
      },
      data: changes,
    });
    if (updated.count !== 1) throw new StaleAggregateError('tracked-delivery', delivery.deliveryId);
  }

  async activeDeliveriesOf(market: MarketContext, courierId: string) {
    const rows = await this.prisma.tx(market).trackingDelivery.findMany({
      where: { marketId: market.marketId, tenantId: market.tenantId, courierId, endedAt: null },
      select: SELECT_DELIVERY,
      orderBy: { startedAt: 'asc' },
      // A courier carries a handful of deliveries at most; the bound keeps a bad report cheap.
      take: 50,
    });
    return rows.map(readDelivery);
  }

  async appendBreadcrumbs(market: MarketContext, breadcrumbs: readonly Breadcrumb[]) {
    await this.prisma.tx(market).trackingBreadcrumb.createMany({
      data: breadcrumbs.map((crumb) => ({
        marketId: market.marketId,
        tenantId: market.tenantId,
        deliveryId: crumb.deliveryId,
        recordedAt: toDate(crumb.recordedAt),
        courierId: crumb.courierId,
        lat: crumb.point.lat,
        lng: crumb.point.lng,
        accuracyMetres: Math.round(crumb.accuracyMetres),
      })),
      // A repeated ping (same delivery and instant) is not a second point.
      skipDuplicates: true,
    });
  }

  async trailOf(market: MarketContext, deliveryId: Id<'Delivery'>, limit: number) {
    const rows = await this.prisma.tx(market).trackingBreadcrumb.findMany({
      where: { marketId: market.marketId, tenantId: market.tenantId, deliveryId },
      select: { recordedAt: true, courierId: true, lat: true, lng: true, accuracyMetres: true },
      orderBy: { recordedAt: 'asc' },
      take: limit,
    });
    return rows.map((row): Breadcrumb => ({
      deliveryId,
      courierId: row.courierId,
      point: { lat: row.lat, lng: row.lng },
      accuracyMetres: row.accuracyMetres,
      recordedAt: toInstant(row.recordedAt),
    }));
  }

  async insertLink(market: MarketContext, link: TrackingLink): Promise<void> {
    await this.prisma.tx(market).trackingLink.createMany({
      data: [
        {
          marketId: market.marketId,
          tenantId: market.tenantId,
          tokenHash: link.tokenHash,
          deliveryId: link.deliveryId,
          createdAt: toDate(link.createdAt),
          expiresAt: toDate(link.expiresAt),
        },
      ],
    });
  }

  async findLink(market: MarketContext, tokenHash: string) {
    const row = await this.prisma.tx(market).trackingLink.findFirst({
      where: { marketId: market.marketId, tenantId: market.tenantId, tokenHash },
      select: { tokenHash: true, deliveryId: true, createdAt: true, expiresAt: true },
    });
    if (row === null) return undefined;
    return {
      tokenHash: row.tokenHash,
      deliveryId: row.deliveryId as Id<'Delivery'>,
      createdAt: toInstant(row.createdAt),
      expiresAt: toInstant(row.expiresAt),
    };
  }

  /**
   * Each kind in one bounded batch: the oldest `batch` rows past the cutoff are found, then
   * everything past the cutoff up to the last of them is deleted (rows with the same instant as
   * the last go too, so a batch can be slightly larger than `batch`).
   */
  async purge(market: MarketContext, cutoffs: PurgeCutoffs, batch: number) {
    const tx = this.prisma.tx(market);
    const scope = { marketId: market.marketId, tenantId: market.tenantId };

    const crumbs = await tx.trackingBreadcrumb.findMany({
      where: { ...scope, recordedAt: { lt: toDate(cutoffs.breadcrumbsBefore) } },
      select: { recordedAt: true },
      orderBy: { recordedAt: 'asc' },
      take: batch,
    });
    const lastCrumb = crumbs.at(-1)?.recordedAt;
    const breadcrumbs =
      lastCrumb === undefined
        ? 0
        : (
            await tx.trackingBreadcrumb.deleteMany({
              where: {
                ...scope,
                recordedAt: { lt: toDate(cutoffs.breadcrumbsBefore), lte: lastCrumb },
              },
            })
          ).count;

    const retention = toDate(cutoffs.deliveriesEndedBefore);
    const ended = await tx.trackingDelivery.findMany({
      where: {
        ...scope,
        OR: [{ endedAt: { lt: retention } }, { endedAt: null, updatedAt: { lt: retention } }],
      },
      select: { deliveryId: true },
      orderBy: { updatedAt: 'asc' },
      take: batch,
    });
    const deliveries =
      ended.length === 0
        ? 0
        : (
            await tx.trackingDelivery.deleteMany({
              where: { ...scope, deliveryId: { in: ended.map((row) => row.deliveryId) } },
            })
          ).count;

    const expired = await tx.trackingLink.findMany({
      where: { ...scope, expiresAt: { lt: toDate(cutoffs.linksExpiredBefore) } },
      select: { tokenHash: true },
      orderBy: { expiresAt: 'asc' },
      take: batch,
    });
    const links =
      expired.length === 0
        ? 0
        : (
            await tx.trackingLink.deleteMany({
              where: { ...scope, tokenHash: { in: expired.map((row) => row.tokenHash) } },
            })
          ).count;

    return { breadcrumbs, deliveries, links };
  }
}
