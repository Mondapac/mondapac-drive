import {
  err,
  ok,
  parseId,
  type CallContext,
  type Id,
  type Result,
} from '@mondapac-drive/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { MAP_VIEW } from '../../contracts/permissions';
import type { Breadcrumb } from '../../domain/breadcrumb';
import { ACCESS_DENIED, isAdmin } from '../callers';
import { deliveryNotTracked, type TrackingFailure } from '../failure';
import type { TrackingRepository } from '../ports';

/** The most points one trail read returns. */
export const MAX_TRAIL_POINTS = 5000;

export interface DeliveryRef {
  readonly deliveryId: Id<'Delivery'>;
}

/** A trail asked for over HTTP: the id as the path carries it, checked after the gate. */
export interface TrailRef {
  readonly deliveryId: string;
}

export interface TrackingStoreDependencies {
  readonly tracking: TrackingRepository;
  readonly unitOfWork: UnitOfWork;
}

/**
 * A delivery's breadcrumb trail, for the dispatcher (and proof-of-route questions). Rule
 * `permissions [tracking.map.view]`, admins only. A malformed id answers as an untracked
 * delivery.
 */
export class DeliveryTrail extends UseCase<TrailRef, Breadcrumb[], TrackingFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'tracking.view-delivery-trail',
    rule: { kind: 'permissions', allOf: [MAP_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: TrackingStoreDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: TrailRef,
  ): Promise<Result<Breadcrumb[], TrackingFailure>> {
    if (!isAdmin(context)) return Promise.resolve(err(ACCESS_DENIED));
    const parsed = parseId<'Delivery'>(input.deliveryId);
    if (!parsed.ok) return Promise.resolve(err(deliveryNotTracked()));
    const deliveryId = parsed.value;
    const { market } = context;
    const { tracking, unitOfWork } = this.deps;
    return unitOfWork.run(
      market,
      async () => {
        const delivery = await tracking.findDelivery(market, deliveryId);
        if (delivery === undefined) return err(deliveryNotTracked());
        return ok(await tracking.trailOf(market, deliveryId, MAX_TRAIL_POINTS));
      },
      { readOnly: true },
    );
  }
}
