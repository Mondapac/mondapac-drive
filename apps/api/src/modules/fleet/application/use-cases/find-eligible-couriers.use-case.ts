import { Inject, Injectable } from '@nestjs/common';
import {
  ok,
  type CallContext,
  type Clock,
  type Id,
  type Temporal,
} from '@mondapac-drive/shared-kernel';
import { CLOCK } from '../../../../platform/clock/clock.module';
import { UNIT_OF_WORK, type UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import type { EmploymentType } from '../../domain/courier-status';
import { holdsValidDocument } from '../../domain/documents';
import { canTakeWork, vehiclesForWork } from '../../domain/eligibility';
import type { Temperature, VehicleType } from '../../domain/vehicle';
import {
  COURIER_REPOSITORY,
  FLEET_RULES,
  type CourierRepository,
  type FleetRulesProvider,
} from '../ports';

/** What dispatch needs a courier for. */
export interface EligibleCourierQuery {
  /** The vehicle types the job can go by; a courier needs an eligible vehicle of one of them. */
  readonly vehicleTypes: readonly VehicleType[];
  /** Chilled or frozen goods: a cold-chain capable courier with a cold box and its documents. */
  readonly coldChain: boolean;
  readonly serviceArea: string;
}

/** A vehicle dispatch may give the courier the job in. */
export interface AvailableFleetVehicle {
  readonly vehicleId: Id<'Vehicle'>;
  readonly type: VehicleType;
  /** The vehicle's own capacity, or the Market rate card's default for its type. */
  readonly maxWeightGrams: number;
  readonly maxVolumeLitres: number;
  /** Ambient, and chilled or frozen only when the courier may carry cold chain in it now. */
  readonly temperatures: readonly Temperature[];
}

/** A courier who can take the job now, with the vehicles for it and how long they have waited. */
export interface AvailableFleetCourier {
  /** The courier's identity account id: the id delivery, tracking and the session use. */
  readonly courierId: string;
  /** Smallest type first. */
  readonly vehicles: readonly AvailableFleetVehicle[];
  /** When the courier last went online from offline or from a delivery. */
  readonly idleSince: Temporal.Instant;
}

/** The most accounts one {@link FleetDirectory.payeeProfiles} call reads. */
export const MAX_PAYEE_PROFILES = 500;

/** What payouts needs to pay a courier: ids, codes and flags, never a business number. */
export interface PayeeProfile {
  /** The courier's identity account id. */
  readonly courierId: string;
  readonly employmentType: EmploymentType;
  /** An operator recorded the courier as registered for the Market's sales tax (GST in AU). */
  readonly taxRegistered: boolean;
  /**
   * The courier holds a verified, unexpired document of the Market's business-id type (the ABN
   * in AU). False in a Market without one.
   */
  readonly businessIdVerified: boolean;
}

/**
 * The fleet's answers to other modules, read only, called in this process by their use cases
 * (dispatch's matching, payouts' runs); no route reaches it. Its methods are not `execute`: the
 * calling module's use case is the gate.
 *
 * - {@link findAvailableCouriers}: who can take a job now, with the vehicles for it (dispatch).
 * - {@link payeeProfiles}: the employment and tax facts of couriers to pay (payouts).
 * - {@link findEligibleCouriers}: the fleet ids of who can take a job now. Kept until dispatch
 *   moves to {@link findAvailableCouriers}; it answers fleet ids, not account ids.
 */
@Injectable()
export class FleetDirectory {
  constructor(
    @Inject(COURIER_REPOSITORY) private readonly couriers: CourierRepository,
    @Inject(FLEET_RULES) private readonly rules: FleetRulesProvider,
    @Inject(UNIT_OF_WORK) private readonly unitOfWork: UnitOfWork,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * The couriers who are active, online, in the service area and eligible by the Clock for a
   * vehicle of one of the asked types (every required document verified and unexpired; for a
   * cold-chain job, the cold-chain documents and a cold box too), longest idle first, then by
   * account id. Each lists only the vehicles fit for the job.
   */
  async findAvailableCouriers(
    context: CallContext,
    query: EligibleCourierQuery,
  ): Promise<AvailableFleetCourier[]> {
    const rules = this.rules.get(context.market.marketId);
    const now = this.clock.now();
    const need = {
      vehicleTypes: query.vehicleTypes,
      coldChain: query.coldChain,
      serviceAreaCode: query.serviceArea,
    };
    const found = await this.unitOfWork.run(
      context.market,
      async () => ok(await this.couriers.findOnlineInArea(context.market, query.serviceArea)),
      { readOnly: true },
    );
    if (!found.ok) return [];
    const available: AvailableFleetCourier[] = [];
    for (const courier of found.value) {
      const vehicles = vehiclesForWork(courier, need, rules, now);
      if (vehicles.length === 0) continue;
      available.push({
        courierId: courier.actorId,
        vehicles: vehicles.map(({ vehicle, temperatures }) => ({
          vehicleId: vehicle.id,
          type: vehicle.type,
          maxWeightGrams: vehicle.maxWeightGrams,
          maxVolumeLitres: vehicle.maxVolumeLitres,
          temperatures,
        })),
        // An online courier always has one (a database CHECK); defensive only.
        idleSince: courier.idleSince ?? courier.createdAt,
      });
    }
    return available.sort(
      (a, b) =>
        a.idleSince.epochMilliseconds - b.idleSince.epochMilliseconds ||
        (a.courierId < b.courierId ? -1 : a.courierId > b.courierId ? 1 : 0),
    );
  }

  /**
   * The payee facts of the couriers of these accounts in the Market, whatever their standing
   * (an offboarded courier is still owed money). Unknown accounts are left out; at most
   * {@link MAX_PAYEE_PROFILES} ids per call, more is a programming error. Throws when the read
   * fails, so the caller fails closed.
   */
  async payeeProfiles(
    context: CallContext,
    courierIds: readonly string[],
  ): Promise<PayeeProfile[]> {
    if (courierIds.length > MAX_PAYEE_PROFILES) {
      throw new RangeError(`At most ${MAX_PAYEE_PROFILES} couriers per call`);
    }
    // An account id is at most 64 characters (fleet.couriers.actor_id); a longer one is nobody.
    const ids = [...new Set(courierIds)].filter((id) => id.length > 0 && id.length <= 64);
    if (ids.length === 0) return [];
    const { businessIdDocumentType } = this.rules.get(context.market.marketId);
    const now = this.clock.now();
    const found = await this.unitOfWork.run(
      context.market,
      async () => ok(await this.couriers.findByActorIds(context.market, ids)),
      { readOnly: true },
    );
    // A failed read fails the payouts run: it must never look like "no such payee".
    if (!found.ok) throw new Error('fleet.payee-profiles.unavailable');
    return found.value.map((courier) => ({
      courierId: courier.actorId,
      employmentType: courier.employmentType,
      taxRegistered: courier.taxRegistered,
      businessIdVerified:
        businessIdDocumentType !== undefined &&
        holdsValidDocument(courier.documents, businessIdDocumentType, now),
    }));
  }

  async findEligibleCouriers(
    context: CallContext,
    query: EligibleCourierQuery,
  ): Promise<Id<'Courier'>[]> {
    const rules = this.rules.get(context.market.marketId);
    const now = this.clock.now();
    const need = {
      vehicleTypes: query.vehicleTypes,
      coldChain: query.coldChain,
      serviceAreaCode: query.serviceArea,
    };
    const found = await this.unitOfWork.run(
      context.market,
      async () => ok(await this.couriers.findOnlineInArea(context.market, query.serviceArea)),
      { readOnly: true },
    );
    if (!found.ok) return [];
    return found.value
      .filter((courier) => canTakeWork(courier, need, rules, now))
      .map((courier) => courier.id);
  }
}
