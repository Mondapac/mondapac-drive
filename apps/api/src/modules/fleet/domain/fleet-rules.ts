import type { MarketId } from '@mondapac-drive/shared-kernel';
import type { EmploymentType } from './courier-status';
import type { VehicleType } from './vehicle';

/**
 * One document a Market requires of its couriers (the `fleet.documents` list of
 * `config/markets/<CODE>.json`). Document types are the Market's own codes, never a fixed list
 * here: the AU file asks for an ABN, another Market for its own business number.
 */
export interface DocumentRequirement {
  /** The Market's code of the document, such as `driver_licence`. */
  readonly type: string;
  /** Who needs it; absent means every courier. */
  readonly employmentTypes?: readonly EmploymentType[];
  /** For which vehicle types; absent means every vehicle type. */
  readonly vehicleTypes?: readonly VehicleType[];
  /** Needed only to carry chilled or frozen goods. */
  readonly coldChainOnly: boolean;
  /** Belongs to one vehicle (its registration) rather than to the courier (a licence). */
  readonly perVehicle: boolean;
  /** The document has an expiry date, which the courier gives when submitting it. */
  readonly expires: boolean;
}

/** The fleet rules of one Market. */
export interface MarketFleetRules {
  readonly marketId: MarketId;
  readonly documents: readonly DocumentRequirement[];
}
