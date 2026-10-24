import { auditField, defineAuditAction } from '@mondapac-drive/shared-kernel';
import { COURIER_STATUSES, EMPLOYMENT_TYPES, SUSPENSION_REASONS } from './courier-status';
import { REJECTION_REASONS } from './documents';

// The operator decisions the fleet module audits (platform/audit). Every document verification
// and every change of a courier's standing is recorded with the operator who made it. No field
// holds a document number, a name or free text.

const status = () => auditField.enumOf(COURIER_STATUSES);

/** The approval records the terms the operator confirmed, which decide the documents asked. */
const terms = () => ({
  status: status(),
  employmentType: auditField.enumOf(EMPLOYMENT_TYPES),
  coldChainCapable: auditField.boolean(),
});

export const courierApproved = defineAuditAction({
  action: 'fleet.courier.approved',
  targetType: 'fleet.courier',
  actors: ['authenticated'],
  before: terms(),
  after: terms(),
});

export const courierSuspendedAudit = defineAuditAction({
  action: 'fleet.courier.suspended',
  targetType: 'fleet.courier',
  actors: ['authenticated'],
  before: { status: status() },
  after: { status: status(), reason: auditField.enumOf(SUSPENSION_REASONS) },
});

export const courierReinstated = defineAuditAction({
  action: 'fleet.courier.reinstated',
  targetType: 'fleet.courier',
  actors: ['authenticated'],
  before: { status: status() },
  after: { status: status() },
});

export const courierOffboarded = defineAuditAction({
  action: 'fleet.courier.offboarded',
  targetType: 'fleet.courier',
  actors: ['authenticated'],
  before: { status: status() },
  after: { status: status() },
});

export const documentVerified = defineAuditAction({
  action: 'fleet.document.verified',
  targetType: 'fleet.document',
  actors: ['authenticated'],
  after: {
    courierId: auditField.id(),
    /** What the courier declared, and what the operator read on the document. */
    declaredExpiresAt: auditField.optional(auditField.instant()),
    expiresAt: auditField.optional(auditField.instant()),
  },
});

export const documentRejected = defineAuditAction({
  action: 'fleet.document.rejected',
  targetType: 'fleet.document',
  actors: ['authenticated'],
  after: { courierId: auditField.id(), reason: auditField.enumOf(REJECTION_REASONS) },
});

export const documentRevoked = defineAuditAction({
  action: 'fleet.document.revoked',
  targetType: 'fleet.document',
  actors: ['authenticated'],
  after: { courierId: auditField.id(), reason: auditField.enumOf(REJECTION_REASONS) },
});

/** Recorded when an operator, not the courier, takes a courier's vehicle out of use. */
export const vehicleDeactivated = defineAuditAction({
  action: 'fleet.vehicle.deactivated',
  targetType: 'fleet.vehicle',
  actors: ['authenticated'],
  after: { courierId: auditField.id() },
});

export const FLEET_AUDIT_ACTIONS = [
  courierApproved,
  courierSuspendedAudit,
  courierReinstated,
  courierOffboarded,
  documentVerified,
  documentRejected,
  documentRevoked,
  vehicleDeactivated,
] as const;
