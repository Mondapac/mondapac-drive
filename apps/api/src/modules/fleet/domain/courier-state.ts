import type { Id, MarketId, Temporal } from '@mondapac-drive/shared-kernel';
import type { CourierStatus, EmploymentType } from './courier-status';
import type { CourierDocument } from './documents';
import type { ShiftState } from './shift';
import type { Vehicle } from './vehicle';

/**
 * A courier of one Market: their standing, shift, vehicles and documents. `actorId` is the
 * identity account the courier signs in with, referenced by id only.
 */
export interface CourierState {
  readonly id: Id<'Courier'>;
  readonly marketId: MarketId;
  readonly actorId: string;
  readonly employmentType: EmploymentType;
  readonly status: CourierStatus;
  readonly serviceAreaCode: string;
  readonly coldChainCapable: boolean;
  readonly shift: ShiftState;
  readonly vehicles: readonly Vehicle[];
  readonly documents: readonly CourierDocument[];
  readonly createdAt: Temporal.Instant;
  /** 1 when registered; every change adds one. */
  readonly version: number;
}
