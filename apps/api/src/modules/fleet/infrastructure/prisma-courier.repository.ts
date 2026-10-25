import { Temporal, type Id, type MarketContext } from '@mondapac-drive/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import { StaleAggregateError } from '../../../platform/unit-of-work/errors';
import type { CourierRepository } from '../application/ports';
import type { CourierState } from '../domain/courier';
import { activeDeliveryOf, type CourierJob } from '../domain/courier-job';
import type { CourierStatus, EmploymentType } from '../domain/courier-status';
import type {
  CourierDocument,
  DocumentMediaType,
  DocumentStatus,
  RejectionReason,
} from '../domain/documents';
import type { ShiftState } from '../domain/shift';
import type { ColdBox, Vehicle, VehicleType } from '../domain/vehicle';
import { readCourierJob, SELECT_COURIER_JOB } from './prisma-courier-job.repository';

const toDate = (instant: Temporal.Instant): Date => new Date(instant.epochMilliseconds);
const toInstant = (date: Date): Temporal.Instant =>
  Temporal.Instant.fromEpochMilliseconds(date.getTime());
const toOptionalDate = (instant: Temporal.Instant | undefined): Date | null =>
  instant === undefined ? null : toDate(instant);

interface CourierRow {
  readonly id: string;
  readonly actorId: string;
  readonly employmentType: string;
  readonly status: string;
  readonly serviceAreaCode: string;
  readonly coldChainCapable: boolean;
  readonly taxRegistered: boolean;
  readonly shift: string;
  readonly idleSince: Date | null;
  readonly createdAt: Date;
  readonly version: number;
}

interface VehicleRow {
  readonly id: string;
  readonly courierId: string;
  readonly type: string;
  readonly plate: string | null;
  readonly maxWeightGrams: number;
  readonly maxVolumeLitres: number;
  readonly coldBox: string;
  readonly active: boolean;
}

interface DocumentRow {
  readonly id: string;
  readonly courierId: string;
  readonly type: string;
  readonly vehicleId: string | null;
  readonly fileKey: string;
  readonly mediaType: string;
  readonly expiresAt: Date | null;
  readonly status: string;
  readonly submittedAt: Date;
  readonly reviewedAt: Date | null;
  readonly rejectionReason: string | null;
}

const SELECT_COURIER = {
  id: true,
  actorId: true,
  employmentType: true,
  status: true,
  serviceAreaCode: true,
  coldChainCapable: true,
  taxRegistered: true,
  shift: true,
  idleSince: true,
  createdAt: true,
  version: true,
} as const;

const SELECT_VEHICLE = {
  id: true,
  courierId: true,
  type: true,
  plate: true,
  maxWeightGrams: true,
  maxVolumeLitres: true,
  coldBox: true,
  active: true,
} as const;

const SELECT_DOCUMENT = {
  id: true,
  courierId: true,
  type: true,
  vehicleId: true,
  fileKey: true,
  mediaType: true,
  expiresAt: true,
  status: true,
  submittedAt: true,
  reviewedAt: true,
  rejectionReason: true,
} as const;

function readVehicle(row: VehicleRow): Vehicle {
  return {
    id: row.id as Id<'Vehicle'>,
    type: row.type as VehicleType,
    ...(row.plate === null ? {} : { plate: row.plate }),
    maxWeightGrams: row.maxWeightGrams,
    maxVolumeLitres: row.maxVolumeLitres,
    coldBox: row.coldBox as ColdBox,
    active: row.active,
  };
}

function readDocument(row: DocumentRow): CourierDocument {
  return {
    id: row.id as Id<'CourierDocument'>,
    type: row.type,
    ...(row.vehicleId === null ? {} : { vehicleId: row.vehicleId as Id<'Vehicle'> }),
    fileKey: row.fileKey,
    mediaType: row.mediaType as DocumentMediaType,
    ...(row.expiresAt === null ? {} : { expiresAt: toInstant(row.expiresAt) }),
    status: row.status as DocumentStatus,
    submittedAt: toInstant(row.submittedAt),
    ...(row.reviewedAt === null ? {} : { reviewedAt: toInstant(row.reviewedAt) }),
    ...(row.rejectionReason === null
      ? {}
      : { rejectionReason: row.rejectionReason as RejectionReason }),
  };
}

function readCourier(
  row: CourierRow,
  vehicles: readonly VehicleRow[],
  documents: readonly DocumentRow[],
  jobs: readonly CourierJob[],
  market: MarketContext,
): CourierState {
  const activeDeliveryId = activeDeliveryOf(
    jobs.filter((job) => job.courierAccountId === row.actorId),
  );
  return {
    id: row.id as Id<'Courier'>,
    marketId: market.marketId,
    actorId: row.actorId,
    employmentType: row.employmentType as EmploymentType,
    status: row.status as CourierStatus,
    serviceAreaCode: row.serviceAreaCode,
    coldChainCapable: row.coldChainCapable,
    taxRegistered: row.taxRegistered,
    shift: row.shift as ShiftState,
    ...(row.idleSince === null ? {} : { idleSince: toInstant(row.idleSince) }),
    ...(activeDeliveryId === undefined ? {} : { activeDeliveryId }),
    vehicles: vehicles.filter((v) => v.courierId === row.id).map(readVehicle),
    documents: documents.filter((d) => d.courierId === row.id).map(readDocument),
    createdAt: toInstant(row.createdAt),
    version: row.version,
  };
}

/**
 * {@link CourierRepository} on `fleet.couriers`, `fleet.vehicles` and `fleet.documents` (and the
 * open jobs of `fleet.courier_jobs`, for the courier's active delivery), through
 * the open unit's guarded client: every `where` and every row pins the unit's Market and tenant.
 * A courier and its vehicles and documents are written by separate statements (the guard refuses
 * nested writes). Vehicles are read in id order (UUIDv7, so by creation), documents by the time
 * they were submitted.
 */
export class PrismaCourierRepository implements CourierRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findById(market: MarketContext, id: Id<'Courier'>) {
    const row = await this.prisma.tx(market).fleetCourier.findFirst({
      where: { marketId: market.marketId, tenantId: market.tenantId, id },
      select: SELECT_COURIER,
    });
    return row === null ? undefined : (await this.withChildren(market, [row]))[0];
  }

  async findByActorId(market: MarketContext, actorId: string) {
    const row = await this.prisma.tx(market).fleetCourier.findFirst({
      where: { marketId: market.marketId, tenantId: market.tenantId, actorId },
      select: SELECT_COURIER,
    });
    return row === null ? undefined : (await this.withChildren(market, [row]))[0];
  }

  async findByActorIds(market: MarketContext, actorIds: readonly string[]) {
    if (actorIds.length === 0) return [];
    const rows = await this.prisma.tx(market).fleetCourier.findMany({
      where: {
        marketId: market.marketId,
        tenantId: market.tenantId,
        actorId: { in: [...actorIds] },
      },
      orderBy: { id: 'asc' },
      select: SELECT_COURIER,
    });
    return this.withChildren(market, rows);
  }

  async list(
    market: MarketContext,
    query: {
      readonly status?: CourierStatus;
      readonly after?: Id<'Courier'>;
      readonly limit: number;
    },
  ) {
    const rows = await this.prisma.tx(market).fleetCourier.findMany({
      where: {
        marketId: market.marketId,
        tenantId: market.tenantId,
        ...(query.status === undefined ? {} : { status: query.status }),
        ...(query.after === undefined ? {} : { id: { gt: query.after } }),
      },
      orderBy: { id: 'asc' },
      take: query.limit,
      select: SELECT_COURIER,
    });
    return this.withChildren(market, rows);
  }

  async namedFileKeys(market: MarketContext, fileKeys: readonly string[]) {
    if (fileKeys.length === 0) return new Set<string>();
    const rows = await this.prisma.tx(market).fleetDocument.findMany({
      // Every tenant's rows: a file key names no tenant, so a sweep that saw only its own
      // tenant's documents would delete another tenant's live files.
      where: { marketId: market.marketId, fileKey: { in: [...fileKeys] } },
      select: { fileKey: true },
    });
    return new Set(rows.map((row) => row.fileKey));
  }

  async findOnlineInArea(market: MarketContext, serviceAreaCode: string) {
    const rows = await this.prisma.tx(market).fleetCourier.findMany({
      where: {
        marketId: market.marketId,
        tenantId: market.tenantId,
        serviceAreaCode,
        status: 'active',
        shift: 'online',
      },
      orderBy: { id: 'asc' },
      select: SELECT_COURIER,
    });
    return this.withChildren(market, rows);
  }

  async insert(market: MarketContext, courier: CourierState): Promise<boolean> {
    const created = await this.prisma.tx(market).fleetCourier.createMany({
      data: [
        {
          marketId: market.marketId,
          tenantId: market.tenantId,
          id: courier.id,
          actorId: courier.actorId,
          employmentType: courier.employmentType,
          status: courier.status,
          serviceAreaCode: courier.serviceAreaCode,
          coldChainCapable: courier.coldChainCapable,
          taxRegistered: courier.taxRegistered,
          shift: courier.shift,
          idleSince: toOptionalDate(courier.idleSince),
          createdAt: toDate(courier.createdAt),
          version: courier.version,
        },
      ],
      skipDuplicates: true,
    });
    if (created.count === 0) return false;
    await this.saveChildren(market, courier);
    return true;
  }

  async update(market: MarketContext, courier: CourierState): Promise<void> {
    const updated = await this.prisma.tx(market).fleetCourier.updateMany({
      where: {
        marketId: market.marketId,
        tenantId: market.tenantId,
        id: courier.id,
        version: courier.version - 1,
      },
      data: {
        status: courier.status,
        shift: courier.shift,
        employmentType: courier.employmentType,
        coldChainCapable: courier.coldChainCapable,
        taxRegistered: courier.taxRegistered,
        idleSince: toOptionalDate(courier.idleSince),
        version: courier.version,
      },
    });
    if (updated.count !== 1) throw new StaleAggregateError('courier', courier.id);
    await this.saveChildren(market, courier);
  }

  /** Inserts the new vehicles and documents and writes the changed ones (under the version lock). */
  private async saveChildren(market: MarketContext, courier: CourierState): Promise<void> {
    const tx = this.prisma.tx(market);
    const scope = { marketId: market.marketId, tenantId: market.tenantId };
    const [vehicles, documents] = await Promise.all([
      tx.fleetVehicle.findMany({
        where: { ...scope, courierId: courier.id },
        select: { id: true, active: true, maxWeightGrams: true, maxVolumeLitres: true },
      }),
      tx.fleetDocument.findMany({
        where: { ...scope, courierId: courier.id },
        select: { id: true, status: true },
      }),
    ]);
    const storedVehicles = new Map(vehicles.map((row) => [row.id, row]));
    const storedDocuments = new Map(documents.map((row) => [row.id, row]));

    const newVehicles = courier.vehicles.filter((v) => !storedVehicles.has(v.id));
    if (newVehicles.length > 0) {
      await tx.fleetVehicle.createMany({
        data: newVehicles.map((vehicle) => ({
          ...scope,
          courierId: courier.id,
          id: vehicle.id,
          type: vehicle.type,
          plate: vehicle.plate ?? null,
          maxWeightGrams: vehicle.maxWeightGrams,
          maxVolumeLitres: vehicle.maxVolumeLitres,
          coldBox: vehicle.coldBox,
          active: vehicle.active,
        })),
      });
    }
    for (const vehicle of courier.vehicles) {
      const stored = storedVehicles.get(vehicle.id);
      if (
        stored === undefined ||
        (stored.active === vehicle.active &&
          stored.maxWeightGrams === vehicle.maxWeightGrams &&
          stored.maxVolumeLitres === vehicle.maxVolumeLitres)
      ) {
        continue;
      }
      await tx.fleetVehicle.updateMany({
        where: { ...scope, courierId: courier.id, id: vehicle.id },
        data: {
          active: vehicle.active,
          maxWeightGrams: vehicle.maxWeightGrams,
          maxVolumeLitres: vehicle.maxVolumeLitres,
        },
      });
    }

    const newDocuments = courier.documents.filter((d) => !storedDocuments.has(d.id));
    if (newDocuments.length > 0) {
      await tx.fleetDocument.createMany({
        data: newDocuments.map((document) => ({
          ...scope,
          courierId: courier.id,
          id: document.id,
          type: document.type,
          vehicleId: document.vehicleId ?? null,
          fileKey: document.fileKey,
          mediaType: document.mediaType,
          expiresAt: toOptionalDate(document.expiresAt),
          status: document.status,
          submittedAt: toDate(document.submittedAt),
          reviewedAt: toOptionalDate(document.reviewedAt),
          rejectionReason: document.rejectionReason ?? null,
        })),
      });
    }
    for (const document of courier.documents) {
      const stored = storedDocuments.get(document.id);
      if (stored === undefined || stored.status === document.status) continue;
      await tx.fleetDocument.updateMany({
        where: { ...scope, courierId: courier.id, id: document.id },
        data: {
          status: document.status,
          expiresAt: toOptionalDate(document.expiresAt),
          reviewedAt: toOptionalDate(document.reviewedAt),
          rejectionReason: document.rejectionReason ?? null,
        },
      });
    }
  }

  private async withChildren(
    market: MarketContext,
    rows: readonly CourierRow[],
  ): Promise<CourierState[]> {
    if (rows.length === 0) return [];
    const tx = this.prisma.tx(market);
    const where = {
      marketId: market.marketId,
      tenantId: market.tenantId,
      courierId: { in: rows.map((row) => row.id) },
    };
    const [vehicles, documents, jobs] = await Promise.all([
      tx.fleetVehicle.findMany({ where, orderBy: { id: 'asc' }, select: SELECT_VEHICLE }),
      tx.fleetDocument.findMany({
        where,
        orderBy: [{ submittedAt: 'asc' }, { id: 'asc' }],
        select: SELECT_DOCUMENT,
      }),
      // The couriers' open jobs: a finished job keeps no courier.
      tx.fleetCourierJob.findMany({
        where: {
          marketId: market.marketId,
          tenantId: market.tenantId,
          courierAccountId: { in: rows.map((row) => row.actorId) },
        },
        select: SELECT_COURIER_JOB,
      }),
    ]);
    const open = jobs.map(readCourierJob);
    return rows.map((row) => readCourier(row, vehicles, documents, open, market));
  }
}
