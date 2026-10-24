import { err, ok, type CallContext, type Result } from '@mondapac-drive/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { MAP_VIEW } from '../../contracts/permissions';
import type { LivePosition, NearbyCourier } from '../../domain/live-position';
import { ACCESS_DENIED, isAdmin } from '../callers';
import { failure, type TrackingFailure } from '../failure';
import {
  findLastKnown,
  findNearest,
  type NearbyQuery,
  type PositionDependencies,
} from '../positions';

export type { NearbyQuery };

export interface CourierRef {
  readonly courierId: string;
}

/**
 * The dispatcher map: the couriers with a fresh position near a point, nearest first, capped by
 * the Market's settings. Rule `permissions [tracking.map.view]`, admins only.
 */
export class ViewNearbyCouriers extends UseCase<NearbyQuery, NearbyCourier[], TrackingFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'tracking.view-nearby-couriers',
    rule: { kind: 'permissions', allOf: [MAP_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: PositionDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: NearbyQuery,
  ): Promise<Result<NearbyCourier[], TrackingFailure>> {
    if (!isAdmin(context)) return err(ACCESS_DENIED);
    return ok(await findNearest(this.deps, context.market, input));
  }
}

/**
 * A courier's latest fresh position, for the dispatcher. Rule `permissions [tracking.map.view]`,
 * admins only. An offline courier, and an unknown or malformed id, answer
 * `tracking.position-not-found` alike.
 */
export class ViewCourierPosition extends UseCase<CourierRef, LivePosition, TrackingFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'tracking.view-courier-position',
    rule: { kind: 'permissions', allOf: [MAP_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: PositionDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: CourierRef,
  ): Promise<Result<LivePosition, TrackingFailure>> {
    if (!isAdmin(context)) return err(ACCESS_DENIED);
    const position = await findLastKnown(this.deps, context.market, input.courierId);
    return position === undefined
      ? err(failure('tracking.position-not-found', 'The courier has no fresh position'))
      : ok(position);
  }
}
