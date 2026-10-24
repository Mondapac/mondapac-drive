import { Inject, Injectable } from '@nestjs/common';
import { ok, type CallContext, type Clock, type Id } from '@mondapac-drive/shared-kernel';
import { CLOCK } from '../../../../platform/clock/clock.module';
import { UNIT_OF_WORK, type UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { canTakeWork } from '../../domain/eligibility';
import type { VehicleType } from '../../domain/vehicle';
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

/**
 * The fleet's answer to dispatch (work package 07): which couriers can take a job now. A
 * courier is listed when active, online, in the service area, and eligible by the Clock for a
 * vehicle of one of the asked types (every required document verified and unexpired). Read
 * only; ids only, never a profile.
 *
 * The method is not `execute`: identity's UseCaseGate (work package 2) wraps it as a system
 * use case of dispatch when it arrives.
 */
@Injectable()
export class FleetDirectory {
  constructor(
    @Inject(COURIER_REPOSITORY) private readonly couriers: CourierRepository,
    @Inject(FLEET_RULES) private readonly rules: FleetRulesProvider,
    @Inject(UNIT_OF_WORK) private readonly unitOfWork: UnitOfWork,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

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
