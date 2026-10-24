import type { CallContext } from '@mondapac-drive/shared-kernel';
import type { LivePosition, NearbyCourier } from '../../domain/live-position';
import {
  findLastKnown,
  findNearest,
  type NearbyQuery,
  type PositionDependencies,
} from '../positions';

/**
 * Tracking's answer to dispatch (work package 07): the couriers near a pickup, and a courier's
 * latest position. In-process only, never served over HTTP: dispatch calls it from inside its
 * own use cases, which have already admitted their caller (a courier answering an offer, an
 * admin dispatching, the sweep job), so it takes their context as it is. Positions only, read
 * for the context's Market and tenant; the dispatcher map goes through `ViewNearbyCouriers`.
 *
 * The methods are not `execute`, like fleet's `FleetDirectory`: dispatch's use cases are the
 * gate of this read. Never feed it into a response that carries coordinates: what leaves dispatch
 * is a courier id and a distance.
 */
export class CourierPositions {
  constructor(private readonly deps: PositionDependencies) {}

  nearest(context: CallContext, query: NearbyQuery): Promise<NearbyCourier[]> {
    return findNearest(this.deps, context.market, query);
  }

  lastKnown(context: CallContext, courierId: string): Promise<LivePosition | undefined> {
    return findLastKnown(this.deps, context.market, courierId);
  }
}
