import { Module, type FactoryProvider } from '@nestjs/common';
import type { Clock, IdGenerator } from '@mondapac-drive/shared-kernel';
import { registerAuditActions } from '../../platform/audit/audit-action-catalogue';
import { registerPermissions, USE_CASE_GATE, type UseCaseGate } from '../../platform/authz';
import { CLOCK } from '../../platform/clock/clock.module';
import { registerEvents } from '../../platform/events/event-catalogue';
import { registerSubscriptionsFrom } from '../../platform/events/event-subscriptions';
import { ID_GENERATOR } from '../../platform/ids/ids.module';
import { PersistenceModule } from '../../platform/persistence/persistence.module';
import { registerJobsFrom } from '../../platform/scheduler/job-registry';
import { OBJECT_STORE, type ObjectStore } from '../../platform/storage/object-store';
import { UNIT_OF_WORK, type UnitOfWork } from '../../platform/unit-of-work/unit-of-work';
import { CourierChanges } from './application/courier-changes';
import type { FleetDependencies } from './application/fleet-dependencies';
import {
  COURIER_JOB_REPOSITORY,
  COURIER_REPOSITORY,
  FLEET_RULES,
  type CourierJobRepository,
  type CourierRepository,
  type FleetRulesProvider,
} from './application/ports';
import {
  AddOwnVehicle,
  ApplyAsCourier,
  ChangeOwnShift,
  DeactivateOwnVehicle,
  DownloadOwnDocument,
  SubmitOwnDocument,
  ViewCourierAppSettings,
  ViewOwnCourierProfile,
} from './application/use-cases/courier-profile.use-case';
import { FleetDirectory } from './application/use-cases/find-eligible-couriers.use-case';
import { FollowDelivery } from './application/use-cases/follow-delivery.use-case';
import {
  ApproveCourier,
  ListCouriers,
  OffboardCourier,
  ReinstateCourier,
  SetCourierTaxRegistration,
  SuspendCourier,
  ViewCourier,
} from './application/use-cases/operator-couriers.use-case';
import {
  DownloadCourierDocument,
  ListExpiringDocuments,
  RejectCourierDocument,
  RevokeCourierDocument,
  VerifyCourierDocument,
} from './application/use-cases/operator-documents.use-case';
import {
  DeactivateCourierVehicle,
  SetVehicleCapacity,
} from './application/use-cases/operator-vehicles.use-case';
import { SweepDocumentFiles } from './application/use-cases/sweep-document-files.use-case';
import { FLEET_PERMISSIONS } from './contracts/permissions';
import { FLEET_AUDIT_ACTIONS } from './domain/audit-actions';
import { FLEET_EVENTS } from './domain/events';
import { fleetProviders } from './infrastructure/fleet-providers';
import { AdminFleetController } from './presentation/admin-fleet.controller';
import { CourierFleetController } from './presentation/courier-fleet.controller';
import { sweepDocumentFilesJob } from './presentation/jobs/sweep-document-files.job';
import { deliveryJobSubscriptions } from './presentation/subscribers/delivery-jobs.subscriptions';

/** The provider of a fleet use case: the gate and the fleet's dependencies. */
function fleetUseCase<U>(
  type: new (gate: UseCaseGate, deps: FleetDependencies) => U,
): FactoryProvider<U> {
  return {
    provide: type,
    inject: [
      USE_CASE_GATE,
      COURIER_REPOSITORY,
      FLEET_RULES,
      CourierChanges,
      UNIT_OF_WORK,
      OBJECT_STORE,
      ID_GENERATOR,
      CLOCK,
    ],
    useFactory: (
      gate: UseCaseGate,
      couriers: CourierRepository,
      rules: FleetRulesProvider,
      changes: CourierChanges,
      unitOfWork: UnitOfWork,
      files: ObjectStore,
      ids: IdGenerator,
      clock: Clock,
    ) => new type(gate, { couriers, rules, changes, unitOfWork, files, ids, clock }),
  };
}

/**
 * Fleet: the couriers of the hybrid fleet, their vehicles with capacity, their documents with
 * expiry, their shifts and idle time, and the answers to dispatch ("who can take this job now")
 * and payouts ("what is this payee"). It follows delivery's events to know which delivery each
 * courier carries (handoff 31). Every HTTP entry goes through a use case behind the
 * UseCaseGate: a courier manages their own profile and shift from the courier app; operators
 * and dispatchers review documents and decide about couriers from the panel.
 */
@Module({
  controllers: [CourierFleetController, AdminFleetController],
  providers: [
    registerEvents('fleet', FLEET_EVENTS),
    registerAuditActions('fleet', FLEET_AUDIT_ACTIONS),
    registerPermissions('fleet', FLEET_PERMISSIONS),
    PersistenceModule.outboxWriterFor('fleet'),
    PersistenceModule.auditWriterFor('fleet'),
    CourierChanges,
    ...[
      ApplyAsCourier,
      ViewOwnCourierProfile,
      ViewCourierAppSettings,
      AddOwnVehicle,
      DeactivateOwnVehicle,
      SubmitOwnDocument,
      DownloadOwnDocument,
      ChangeOwnShift,
      ListCouriers,
      ViewCourier,
      ApproveCourier,
      SuspendCourier,
      ReinstateCourier,
      OffboardCourier,
      SetCourierTaxRegistration,
      VerifyCourierDocument,
      RejectCourierDocument,
      RevokeCourierDocument,
      DownloadCourierDocument,
      ListExpiringDocuments,
      DeactivateCourierVehicle,
      SetVehicleCapacity,
      SweepDocumentFiles,
    ].map((type) => fleetUseCase<unknown>(type)),
    FleetDirectory,
    ...fleetProviders,
    {
      provide: FollowDelivery,
      inject: [USE_CASE_GATE, COURIER_JOB_REPOSITORY, COURIER_REPOSITORY, UNIT_OF_WORK],
      useFactory: (
        gate: UseCaseGate,
        jobs: CourierJobRepository,
        couriers: CourierRepository,
        unitOfWork: UnitOfWork,
      ) => new FollowDelivery(gate, { jobs, couriers, unitOfWork }),
    },
    registerSubscriptionsFrom('fleet', [FollowDelivery], (follow: FollowDelivery) =>
      deliveryJobSubscriptions(follow),
    ),
    registerJobsFrom('fleet', [SweepDocumentFiles], (sweep: SweepDocumentFiles) => [
      sweepDocumentFilesJob(sweep),
    ]),
  ],
  exports: [FleetDirectory],
})
export class FleetModule {}
