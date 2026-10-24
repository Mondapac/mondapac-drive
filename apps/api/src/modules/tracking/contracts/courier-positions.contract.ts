// tracking's live positions for dispatch's matching, without the UseCaseGate. Not exported by
// index.ts: dependency-cruiser `courier-positions-are-for-dispatch` lets only dispatch import
// this file (security review of tracking 06b, L2). Every other reader of live positions goes
// through the gated `tracking.map.view` use cases.
export { CourierPositions } from '../application/use-cases/courier-positions.use-case';
export type { NearbyQuery } from '../application/use-cases/view-courier-positions.use-case';
export type { LivePosition, NearbyCourier } from '../domain/live-position';
