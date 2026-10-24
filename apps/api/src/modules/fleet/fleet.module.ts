import { Module } from '@nestjs/common';
import { registerAuditActions } from '../../platform/audit/audit-action-catalogue';
import { registerEvents } from '../../platform/events/event-catalogue';
import { PersistenceModule } from '../../platform/persistence/persistence.module';
import { ChangeShift } from './application/change-shift';
import { CourierChanges } from './application/courier-changes';
import { GetCourier } from './application/get-courier';
import { AddVehicle, DeactivateVehicle } from './application/manage-vehicles';
import {
  ApproveCourier,
  OffboardCourier,
  ReinstateCourier,
  SuspendCourier,
} from './application/operator-decisions';
import { RegisterCourier } from './application/register-courier';
import { RejectCourierDocument, VerifyCourierDocument } from './application/review-document';
import { SubmitCourierDocument } from './application/submit-document';
import { FleetDirectory } from './application/use-cases/find-eligible-couriers.use-case';
import { FLEET_AUDIT_ACTIONS } from './domain/audit-actions';
import { FLEET_EVENTS } from './domain/events';
import { fleetProviders } from './infrastructure/fleet-providers';

/**
 * Fleet: the couriers of the hybrid fleet, their vehicles, their documents with expiry and
 * their shifts, and the answer to dispatch's "who can take this job now". No route yet: the
 * courier and operator routes arrive with identity's populations (work package 2).
 */
@Module({
  providers: [
    registerEvents('fleet', FLEET_EVENTS),
    registerAuditActions('fleet', FLEET_AUDIT_ACTIONS),
    PersistenceModule.outboxWriterFor('fleet'),
    PersistenceModule.auditWriterFor('fleet'),
    CourierChanges,
    RegisterCourier,
    GetCourier,
    AddVehicle,
    DeactivateVehicle,
    SubmitCourierDocument,
    ChangeShift,
    ApproveCourier,
    SuspendCourier,
    ReinstateCourier,
    OffboardCourier,
    VerifyCourierDocument,
    RejectCourierDocument,
    FleetDirectory,
    ...fleetProviders,
  ],
  exports: [FleetDirectory],
})
export class FleetModule {}
