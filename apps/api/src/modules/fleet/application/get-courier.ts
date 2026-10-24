import { Inject, Injectable } from '@nestjs/common';
import { err, ok, type CallContext, type Id, type Result } from '@mondapac-drive/shared-kernel';
import { UNIT_OF_WORK, type UnitOfWork } from '../../../platform/unit-of-work/unit-of-work';
import type { CourierState } from '../domain/courier';
import { isCourierThemself, isOperator } from './access';
import { courierNotFound, type FleetFailure } from './failure';
import { COURIER_REPOSITORY, type CourierRepository } from './ports';

/** A courier's profile, for the courier themself or an operator. */
@Injectable()
export class GetCourier {
  constructor(
    @Inject(COURIER_REPOSITORY) private readonly couriers: CourierRepository,
    @Inject(UNIT_OF_WORK) private readonly unitOfWork: UnitOfWork,
  ) {}

  execute(
    context: CallContext,
    courierId: Id<'Courier'>,
  ): Promise<Result<CourierState, FleetFailure>> {
    return this.unitOfWork.run(
      context.market,
      async (): Promise<Result<CourierState, FleetFailure>> => {
        const courier = await this.couriers.findById(context.market, courierId);
        return courier !== undefined && (isOperator(context) || isCourierThemself(context, courier))
          ? ok(courier)
          : err(courierNotFound());
      },
      { readOnly: true },
    );
  }
}
