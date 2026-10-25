import { Temporal, type Id, type MarketContext } from '@mondapac-drive/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import { StaleAggregateError } from '../../../platform/unit-of-work/errors';
import type { CourierJobRepository } from '../application/ports';
import type { CourierJob } from '../domain/courier-job';

/** The columns of `fleet.courier_jobs` the module reads. */
export const SELECT_COURIER_JOB = {
  deliveryId: true,
  courierAccountId: true,
  assignedAt: true,
  ended: true,
  deliveryVersion: true,
} as const;

export interface CourierJobRow {
  readonly deliveryId: string;
  readonly courierAccountId: string | null;
  readonly assignedAt: Date | null;
  readonly ended: boolean;
  readonly deliveryVersion: number;
}

export function readCourierJob(row: CourierJobRow): CourierJob {
  return {
    deliveryId: row.deliveryId as Id<'Delivery'>,
    ...(row.courierAccountId === null || row.assignedAt === null
      ? {}
      : {
          courierAccountId: row.courierAccountId,
          assignedAt: Temporal.Instant.fromEpochMilliseconds(row.assignedAt.getTime()),
        }),
    ended: row.ended,
    deliveryVersion: row.deliveryVersion,
  };
}

const columnsOf = (job: CourierJob) => ({
  courierAccountId: job.courierAccountId ?? null,
  assignedAt: job.assignedAt === undefined ? null : new Date(job.assignedAt.epochMilliseconds),
  ended: job.ended,
  deliveryVersion: job.deliveryVersion,
});

/**
 * {@link CourierJobRepository} on `fleet.courier_jobs`, through the open unit's guarded client.
 * The applied delivery version is the row's lock: a write over a version that moved meanwhile
 * throws, and the event is retried.
 */
export class PrismaCourierJobRepository implements CourierJobRepository {
  constructor(private readonly prisma: PrismaService) {}

  async find(market: MarketContext, deliveryId: Id<'Delivery'>) {
    const row = await this.prisma.tx(market).fleetCourierJob.findFirst({
      where: { marketId: market.marketId, tenantId: market.tenantId, deliveryId },
      select: SELECT_COURIER_JOB,
    });
    return row === null ? undefined : readCourierJob(row);
  }

  async save(market: MarketContext, job: CourierJob, previousVersion: number | undefined) {
    const tx = this.prisma.tx(market);
    const scope = { marketId: market.marketId, tenantId: market.tenantId };
    if (previousVersion === undefined) {
      const created = await tx.fleetCourierJob.createMany({
        data: [{ ...scope, deliveryId: job.deliveryId, ...columnsOf(job) }],
        skipDuplicates: true,
      });
      if (created.count !== 1) throw new StaleAggregateError('courier-job', job.deliveryId);
      return;
    }
    const updated = await tx.fleetCourierJob.updateMany({
      where: { ...scope, deliveryId: job.deliveryId, deliveryVersion: previousVersion },
      data: columnsOf(job),
    });
    if (updated.count !== 1) throw new StaleAggregateError('courier-job', job.deliveryId);
  }
}
