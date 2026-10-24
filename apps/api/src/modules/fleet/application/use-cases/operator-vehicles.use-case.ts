import { err, type CallContext, type Id, type Result } from '@mondapac-drive/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { VEHICLE_MANAGE } from '../../contracts/permissions';
import { vehicleCapacitySet, vehicleDeactivated } from '../../domain/audit-actions';
import { deactivateVehicle, setVehicleCapacity, type CourierState } from '../../domain/courier';
import type { VehicleCapacity } from '../../domain/vehicle';
import { isOperator } from '../access';
import { forbidden, type FleetFailure } from '../failure';
import type { FleetDependencies } from '../fleet-dependencies';

// An operator's changes to a courier's vehicle, each audited with the operator who made it.

type Outcome<T> = Promise<Result<T, FleetFailure>>;

export interface CourierVehicleRef {
  readonly courierId: Id<'Courier'>;
  readonly vehicleId: Id<'Vehicle'>;
}

/** Takes a courier's vehicle out of use. Rule `permissions [fleet.vehicle.manage]`. */
export class DeactivateCourierVehicle extends UseCase<
  CourierVehicleRef,
  CourierState,
  FleetFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'fleet.deactivate-courier-vehicle',
    rule: { kind: 'permissions', allOf: [VEHICLE_MANAGE.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: FleetDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: CourierVehicleRef): Outcome<CourierState> {
    if (!isOperator(context)) return Promise.resolve(err(forbidden()));
    const { vehicleId } = input;
    return this.deps.changes.apply(
      context,
      { id: input.courierId },
      {
        allowed: () => true,
        decide: (courier) => deactivateVehicle(courier, vehicleId),
        audit: (_before, after) =>
          vehicleDeactivated.entry(vehicleId, { after: { courierId: after.id } }),
      },
    );
  }
}

export interface VehicleCapacityInput extends CourierVehicleRef {
  readonly capacity: VehicleCapacity;
}

/**
 * Replaces a vehicle's capacity with the operator's measure (dispatch matches parcels on it).
 * Rule `permissions [fleet.vehicle.manage]`.
 */
export class SetVehicleCapacity extends UseCase<VehicleCapacityInput, CourierState, FleetFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'fleet.set-vehicle-capacity',
    rule: { kind: 'permissions', allOf: [VEHICLE_MANAGE.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: FleetDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: VehicleCapacityInput): Outcome<CourierState> {
    if (!isOperator(context)) return Promise.resolve(err(forbidden()));
    const { vehicleId, capacity } = input;
    return this.deps.changes.apply(
      context,
      { id: input.courierId },
      {
        allowed: () => true,
        decide: (courier) => setVehicleCapacity(courier, vehicleId, capacity),
        audit: (before, after) => {
          const old = before.vehicles.find((v) => v.id === vehicleId)!;
          return vehicleCapacitySet.entry(vehicleId, {
            before: { maxWeightGrams: old.maxWeightGrams, maxVolumeLitres: old.maxVolumeLitres },
            after: { courierId: after.id, ...capacity },
          });
        },
      },
    );
  }
}
