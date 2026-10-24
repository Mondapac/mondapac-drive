import { Inject, Injectable } from '@nestjs/common';
import type { CallContext, Id, IdGenerator, Result } from '@mondapac-drive/shared-kernel';
import { ID_GENERATOR } from '../../../platform/ids/ids.module';
import { vehicleDeactivated } from '../domain/audit-actions';
import { addVehicle, deactivateVehicle, type CourierState } from '../domain/courier';
import type { ColdBox, VehicleType } from '../domain/vehicle';
import { capacityFor } from '../domain/vehicle-class';
import { isCourierThemself, isOperator } from './access';
import { CourierChanges } from './courier-changes';
import type { FleetFailure } from './failure';

export interface AddVehicleInput {
  readonly type: VehicleType;
  readonly plate?: string;
  /** Absent: the Market rate card's default for the type. */
  readonly maxWeightGrams?: number;
  /** Absent: the Market rate card's default for the type. */
  readonly maxVolumeLitres?: number;
  readonly coldBox: ColdBox;
}

/**
 * The courier adds a vehicle they deliver with. Its registration is a document of its own. A
 * capacity not given is the Market rate card's for the type; a type the Market does not offer
 * is refused.
 */
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
      decide: (courier, rules) =>
        addVehicle(courier, {
          id,
          type: input.type,
          ...(input.plate === undefined ? {} : { plate: input.plate }),
          coldBox: input.coldBox,
          ...capacityFor(input.type, input, rules),
        }),
    });
  }
}

/** The courier, or an operator, takes a vehicle out of use; an operator's doing is audited. */
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
      audit: (before, after) =>
        isCourierThemself(context, before)
          ? undefined
          : vehicleDeactivated.entry(vehicleId, { after: { courierId: after.id } }),
    });
  }
}
