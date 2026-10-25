import { geoPoint, Temporal, type Id, type MarketContext } from '@mondapac-drive/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import { StaleAggregateError } from '../../../platform/unit-of-work/errors';
import type { DispatchJobRepository } from '../application/ports';
import type { Temperature, VehicleType } from '../domain/courier';
import type {
  AssignmentMethod,
  DispatchJob,
  JobStatus,
  Offer,
  OfferStatus,
  OfferStops,
} from '../domain/dispatch-job';

const toDate = (instant: Temporal.Instant): Date => new Date(instant.epochMilliseconds);
const toInstant = (date: Date): Temporal.Instant =>
  Temporal.Instant.fromEpochMilliseconds(date.getTime());

/**
 * The most pending offers of one courier read for the current offer. A wave sends one offer per
 * courier and job, and an expired one stays PENDING only until the next sweep.
 */
const PENDING_OFFERS_READ = 5;

/** The statuses whose job may still have work for the sweep. */
const OPEN_STATUSES: JobStatus[] = ['WAITING', 'OFFERING'];

const SELECT_JOB = {
  id: true,
  deliveryId: true,
  status: true,
  serviceAreaCode: true,
  pickupLat: true,
  pickupLng: true,
  minimumVehicle: true,
  weightGrams: true,
  volumeLitres: true,
  temperature: true,
  opensAt: true,
  round: true,
  nextActionAt: true,
  assignedCourierId: true,
  assignedVehicle: true,
  assignmentMethod: true,
  assignedAt: true,
  excludedCourierIds: true,
  pickupSuburb: true,
  pickupPostcode: true,
  dropoffSuburb: true,
  dropoffPostcode: true,
  dropoffLat: true,
  dropoffLng: true,
  tripDistanceMetres: true,
  deliveryVersion: true,
  createdAt: true,
  version: true,
} as const;

const SELECT_OFFER = {
  id: true,
  courierId: true,
  vehicle: true,
  round: true,
  status: true,
  sentAt: true,
  expiresAt: true,
  answeredAt: true,
} as const;

interface JobRow {
  readonly id: string;
  readonly deliveryId: string;
  readonly status: string;
  readonly serviceAreaCode: string;
  readonly pickupLat: number;
  readonly pickupLng: number;
  readonly minimumVehicle: string;
  readonly weightGrams: number;
  readonly volumeLitres: number;
  readonly temperature: string;
  readonly opensAt: Date;
  readonly round: number;
  readonly nextActionAt: Date | null;
  readonly assignedCourierId: string | null;
  readonly assignedVehicle: string | null;
  readonly assignmentMethod: string | null;
  readonly assignedAt: Date | null;
  readonly excludedCourierIds: string[];
  readonly pickupSuburb: string | null;
  readonly pickupPostcode: string | null;
  readonly dropoffSuburb: string | null;
  readonly dropoffPostcode: string | null;
  readonly dropoffLat: number | null;
  readonly dropoffLng: number | null;
  readonly tripDistanceMetres: number | null;
  readonly deliveryVersion: number;
  readonly createdAt: Date;
  readonly version: number;
}

/**
 * The offer's stops, when the row still holds them (the postcodes, the drop-off point and the
 * distance are set together; a suburb may be null within them).
 */
function readStops(row: JobRow): OfferStops | undefined {
  const { pickupPostcode, dropoffPostcode, dropoffLat, dropoffLng, tripDistanceMetres } = row;
  if (
    pickupPostcode === null ||
    dropoffPostcode === null ||
    dropoffLat === null ||
    dropoffLng === null ||
    tripDistanceMetres === null
  ) {
    return undefined;
  }
  return {
    pickupArea: { suburb: row.pickupSuburb, postcode: pickupPostcode },
    dropoffArea: { suburb: row.dropoffSuburb, postcode: dropoffPostcode },
    dropoff: geoPoint(dropoffLat, dropoffLng),
    tripDistanceMetres,
  };
}

interface OfferRow {
  readonly id: string;
  readonly courierId: string;
  readonly vehicle: string;
  readonly round: number;
  readonly status: string;
  readonly sentAt: Date;
  readonly expiresAt: Date;
  readonly answeredAt: Date | null;
}

function readOffer(row: OfferRow): Offer {
  return {
    id: row.id as Id<'DispatchOffer'>,
    courierId: row.courierId as Id<'Courier'>,
    vehicle: row.vehicle as VehicleType,
    round: row.round,
    status: row.status as OfferStatus,
    sentAt: toInstant(row.sentAt),
    expiresAt: toInstant(row.expiresAt),
    ...(row.answeredAt === null ? {} : { answeredAt: toInstant(row.answeredAt) }),
  };
}

function readJob(row: JobRow, offers: readonly OfferRow[], market: MarketContext): DispatchJob {
  const stops = readStops(row);
  return {
    id: row.id as Id<'DispatchJob'>,
    marketId: market.marketId,
    deliveryId: row.deliveryId as Id<'Delivery'>,
    requirements: {
      serviceAreaCode: row.serviceAreaCode,
      pickup: geoPoint(row.pickupLat, row.pickupLng),
      minimumVehicle: row.minimumVehicle as VehicleType,
      weightGrams: row.weightGrams,
      volumeLitres: row.volumeLitres,
      temperature: row.temperature as Temperature,
    },
    ...(stops === undefined ? {} : { stops }),
    status: row.status as JobStatus,
    opensAt: toInstant(row.opensAt),
    round: row.round,
    ...(row.nextActionAt === null ? {} : { nextActionAt: toInstant(row.nextActionAt) }),
    offers: offers.map(readOffer),
    ...(row.assignedCourierId !== null &&
    row.assignedVehicle !== null &&
    row.assignmentMethod !== null &&
    row.assignedAt !== null
      ? {
          assignment: {
            courierId: row.assignedCourierId as Id<'Courier'>,
            vehicle: row.assignedVehicle as VehicleType,
            method: row.assignmentMethod as AssignmentMethod,
            at: toInstant(row.assignedAt),
          },
        }
      : {}),
    excludedCourierIds: row.excludedCourierIds as Id<'Courier'>[],
    deliveryVersion: row.deliveryVersion,
    createdAt: toInstant(row.createdAt),
    version: row.version,
  };
}

/** The columns of a job that change after it is opened. */
function changingColumns(job: DispatchJob) {
  return {
    status: job.status,
    round: job.round,
    nextActionAt: job.nextActionAt === undefined ? null : toDate(job.nextActionAt),
    assignedCourierId: job.assignment?.courierId ?? null,
    assignedVehicle: job.assignment?.vehicle ?? null,
    assignmentMethod: job.assignment?.method ?? null,
    assignedAt: job.assignment === undefined ? null : toDate(job.assignment.at),
    excludedCourierIds: [...job.excludedCourierIds],
    opensAt: toDate(job.opensAt),
    pickupSuburb: job.stops?.pickupArea.suburb ?? null,
    pickupPostcode: job.stops?.pickupArea.postcode ?? null,
    dropoffSuburb: job.stops?.dropoffArea.suburb ?? null,
    dropoffPostcode: job.stops?.dropoffArea.postcode ?? null,
    dropoffLat: job.stops?.dropoff.lat ?? null,
    dropoffLng: job.stops?.dropoff.lng ?? null,
    tripDistanceMetres: job.stops?.tripDistanceMetres ?? null,
    deliveryVersion: job.deliveryVersion,
    version: job.version,
  };
}

/**
 * {@link DispatchJobRepository} on `dispatch.jobs` and `dispatch.offers`, through the open
 * unit's guarded client: every `where` and every row pins the unit's Market and tenant. A job
 * and its offers are written by separate statements (the guard refuses nested writes).
 */
export class PrismaDispatchJobRepository implements DispatchJobRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findById(market: MarketContext, id: Id<'DispatchJob'>) {
    const row = await this.prisma.tx(market).dispatchJob.findFirst({
      where: { marketId: market.marketId, tenantId: market.tenantId, id },
      select: SELECT_JOB,
    });
    return row === null ? undefined : this.withOffers(market, row);
  }

  async findByDelivery(market: MarketContext, deliveryId: Id<'Delivery'>) {
    const row = await this.prisma.tx(market).dispatchJob.findFirst({
      where: { marketId: market.marketId, tenantId: market.tenantId, deliveryId },
      select: SELECT_JOB,
    });
    return row === null ? undefined : this.withOffers(market, row);
  }

  async findByOffer(market: MarketContext, offerId: Id<'DispatchOffer'>) {
    const offer = await this.prisma.tx(market).dispatchOffer.findFirst({
      where: { marketId: market.marketId, tenantId: market.tenantId, id: offerId },
      select: { jobId: true },
    });
    return offer === null ? undefined : this.findById(market, offer.jobId as Id<'DispatchJob'>);
  }

  async findWithPendingOfferFor(market: MarketContext, courierId: Id<'Courier'>) {
    const offers = await this.prisma.tx(market).dispatchOffer.findMany({
      where: {
        marketId: market.marketId,
        tenantId: market.tenantId,
        courierId,
        status: 'PENDING',
      },
      orderBy: { expiresAt: 'asc' },
      take: PENDING_OFFERS_READ,
      select: { jobId: true },
    });
    const jobs: DispatchJob[] = [];
    for (const jobId of new Set(offers.map((offer) => offer.jobId))) {
      const job = await this.findById(market, jobId as Id<'DispatchJob'>);
      if (job !== undefined) jobs.push(job);
    }
    return jobs;
  }

  async findDue(market: MarketContext, now: Temporal.Instant, limit: number) {
    const rows = await this.prisma.tx(market).dispatchJob.findMany({
      where: {
        marketId: market.marketId,
        tenantId: market.tenantId,
        status: { in: OPEN_STATUSES },
        nextActionAt: { lte: toDate(now) },
      },
      orderBy: [{ nextActionAt: 'asc' }, { id: 'asc' }],
      take: limit,
      select: { id: true },
    });
    return rows.map((row) => row.id as Id<'DispatchJob'>);
  }

  async insert(market: MarketContext, job: DispatchJob): Promise<boolean> {
    const created = await this.prisma.tx(market).dispatchJob.createMany({
      data: [
        {
          marketId: market.marketId,
          tenantId: market.tenantId,
          id: job.id,
          deliveryId: job.deliveryId,
          serviceAreaCode: job.requirements.serviceAreaCode,
          pickupLat: job.requirements.pickup.lat,
          pickupLng: job.requirements.pickup.lng,
          minimumVehicle: job.requirements.minimumVehicle,
          weightGrams: job.requirements.weightGrams,
          volumeLitres: job.requirements.volumeLitres,
          temperature: job.requirements.temperature,
          createdAt: toDate(job.createdAt),
          ...changingColumns(job),
        },
      ],
      skipDuplicates: true,
    });
    if (created.count === 0) return false;
    await this.saveOffers(market, job, []);
    return true;
  }

  async update(market: MarketContext, job: DispatchJob): Promise<void> {
    const tx = this.prisma.tx(market);
    const updated = await tx.dispatchJob.updateMany({
      where: {
        marketId: market.marketId,
        tenantId: market.tenantId,
        id: job.id,
        version: job.version - 1,
      },
      data: changingColumns(job),
    });
    if (updated.count !== 1) throw new StaleAggregateError('dispatch-job', job.id);
    const stored = await tx.dispatchOffer.findMany({
      where: { marketId: market.marketId, tenantId: market.tenantId, jobId: job.id },
      select: { id: true, status: true },
    });
    await this.saveOffers(market, job, stored);
  }

  /** Inserts the offers not stored yet and writes the answer of those whose status changed. */
  private async saveOffers(
    market: MarketContext,
    job: DispatchJob,
    stored: readonly { readonly id: string; readonly status: string }[],
  ): Promise<void> {
    const tx = this.prisma.tx(market);
    const scope = { marketId: market.marketId, tenantId: market.tenantId };
    const known = new Map(stored.map((offer) => [offer.id, offer.status]));
    const added = job.offers
      .map((offer, index) => ({ offer, sequence: index + 1 }))
      .filter(({ offer }) => !known.has(offer.id));
    if (added.length > 0) {
      await tx.dispatchOffer.createMany({
        data: added.map(({ offer, sequence }) => ({
          ...scope,
          id: offer.id,
          jobId: job.id,
          sequence,
          courierId: offer.courierId,
          vehicle: offer.vehicle,
          round: offer.round,
          status: offer.status,
          sentAt: toDate(offer.sentAt),
          expiresAt: toDate(offer.expiresAt),
          answeredAt: offer.answeredAt === undefined ? null : toDate(offer.answeredAt),
        })),
      });
    }
    for (const offer of job.offers) {
      const before = known.get(offer.id);
      if (before === undefined || before === offer.status) continue;
      await tx.dispatchOffer.updateMany({
        where: { ...scope, jobId: job.id, id: offer.id, status: before },
        data: {
          status: offer.status,
          answeredAt: offer.answeredAt === undefined ? null : toDate(offer.answeredAt),
        },
      });
    }
  }

  private async withOffers(market: MarketContext, row: JobRow): Promise<DispatchJob> {
    const offers = await this.prisma.tx(market).dispatchOffer.findMany({
      where: { marketId: market.marketId, tenantId: market.tenantId, jobId: row.id },
      orderBy: { sequence: 'asc' },
      select: SELECT_OFFER,
    });
    return readJob(row, offers, market);
  }
}
