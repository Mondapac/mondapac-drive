import { Inject, Injectable } from '@nestjs/common';
import {
  err,
  ok,
  type CallContext,
  type Clock,
  type IdGenerator,
  type Result,
} from '@mondapac-drive/shared-kernel';
import { CLOCK } from '../../../platform/clock/clock.module';
import { ID_GENERATOR } from '../../../platform/ids/ids.module';
import { UNIT_OF_WORK, type UnitOfWork } from '../../../platform/unit-of-work/unit-of-work';
import { registerCourier, type CourierState } from '../domain/courier';
import type { EmploymentType } from '../domain/courier-status';
import { accountOf } from './access';
import { forbidden, refusingBrokenRules, type FleetFailure } from './failure';
import {
  COURIER_REPOSITORY,
  FLEET_RULES,
  type CourierRepository,
  type FleetRulesProvider,
} from './ports';

export interface RegisterCourierInput {
  readonly employmentType: EmploymentType;
  readonly serviceAreaCode: string;
  readonly coldChainCapable: boolean;
}

export interface RegisteredCourier {
  readonly courier: CourierState;
  readonly created: boolean;
}

/**
 * A signed-in person applies to deliver. Idempotent per account: applying again answers the
 * profile already there. The profile starts as an applicant until an operator approves it.
 */
@Injectable()
export class RegisterCourier {
  constructor(
    @Inject(COURIER_REPOSITORY) private readonly couriers: CourierRepository,
    @Inject(FLEET_RULES) private readonly rules: FleetRulesProvider,
    @Inject(UNIT_OF_WORK) private readonly unitOfWork: UnitOfWork,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  execute(
    context: CallContext,
    input: RegisterCourierInput,
  ): Promise<Result<RegisteredCourier, FleetFailure>> {
    const actorId = accountOf(context);
    if (actorId === undefined) return Promise.resolve(err(forbidden()));
    const { market } = context;
    if (!this.rules.hasServiceArea(market.marketId, input.serviceAreaCode)) {
      return Promise.resolve(
        err({ code: 'fleet.service-area.unknown', message: 'The Market has no such service area' }),
      );
    }
    return this.unitOfWork.run(market, () =>
      refusingBrokenRules(async (): Promise<Result<RegisteredCourier, FleetFailure>> => {
        const existing = await this.couriers.findByActorId(market, actorId);
        if (existing !== undefined) return ok({ courier: existing, created: false });
        const courier = registerCourier({
          id: this.ids.next<'Courier'>(),
          marketId: market.marketId,
          actorId,
          employmentType: input.employmentType,
          serviceAreaCode: input.serviceAreaCode,
          coldChainCapable: input.coldChainCapable,
          createdAt: this.clock.now(),
        });
        if (await this.couriers.insert(market, courier)) return ok({ courier, created: true });
        const raced = await this.couriers.findByActorId(market, actorId);
        return raced
          ? ok({ courier: raced, created: false })
          : err({ code: 'fleet.conflict', message: 'The profile could not be saved; retry' });
      }),
    );
  }
}
