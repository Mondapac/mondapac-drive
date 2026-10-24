import type { Clock, IdGenerator } from '@mondapac-drive/shared-kernel';
import type { ObjectStore } from '../../../platform/storage/object-store';
import type { UnitOfWork } from '../../../platform/unit-of-work/unit-of-work';
import type { CourierChanges } from './courier-changes';
import type { CourierRepository, FleetRulesProvider } from './ports';

/** What the fleet's use cases work with; the module's providers build one per use case. */
export interface FleetDependencies {
  readonly couriers: CourierRepository;
  readonly rules: FleetRulesProvider;
  readonly changes: CourierChanges;
  readonly unitOfWork: UnitOfWork;
  readonly files: ObjectStore;
  readonly ids: IdGenerator;
  readonly clock: Clock;
}
