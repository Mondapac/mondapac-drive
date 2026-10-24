import { Inject, Injectable } from '@nestjs/common';
import type { CallContext, Id, IdGenerator, Result } from '@mondapac-drive/shared-kernel';
import { ID_GENERATOR } from '../../../platform/ids/ids.module';
import { addVehicle, deactivateVehicle, type CourierState } from '../domain/courier';
import type { ColdBox, VehicleType } from '../domain/vehicle';
import { isCourierThemself, isOperator } from './access';
import { CourierChanges } from './courier-changes';
import type { FleetFailure } from './failure';

export interface AddVehicleInput {
  readonly type: VehicleType;
  readonly plate?: string;
  readonly maxWeightGrams: number;
  readonly maxVolumeLitres: number;
  readonly coldBox: ColdBox;
}

/** The courier adds a vehicle they deliver with. Its registration is a document of its own. */
@Injectable()
export class AddVehicle {
  constructor(
    private readonly changes: CourierChanges,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
  ) {}

  execute(
    context: CallContext,
    courierId: Id<'Courier'>,
    input: AddVehicleInput,
  ): Promise<Result<CourierState, FleetFailure>> {
    const id = this.ids.next<'Vehicle'>();
    return this.changes.apply(context, courierId, {
      allowed: (courier) => isCourierThemself(context, courier),
      decide: (courier) => addVehicle(courier, { ...input, id }),
    });
  }
}

/** The courier, or an operator, takes a vehicle out of use. */
@Injectable()
export class DeactivateVehicle {
  constructor(private readonly changes: CourierChanges) {}

  execute(
    context: CallContext,
    courierId: Id<'Courier'>,
    vehicleId: Id<'Vehicle'>,
  ): Promise<Result<CourierState, FleetFailure>> {
    return this.changes.apply(context, courierId, {
      allowed: (courier) => isCourierThemself(context, courier) || isOperator(context),
      decide: (courier) => deactivateVehicle(courier, vehicleId),
    });
  }
}
