import { auditField, defineAuditAction } from '@mondapac-drive/shared-kernel';
import { VEHICLE_TYPES } from './courier';
import type { JobStatus } from './dispatch-job';

// The dispatcher decisions the dispatch module audits (platform/audit): who assigned or
// reassigned a delivery's courier, and who restarted offering. Ids and codes only.

/** A job's status as an audit row records it: the kernel's codes are lower-case. */
export const JOB_STATUS_CODES = [
  'waiting',
  'offering',
  'assigned',
  'exhausted',
  'collected',
  'cancelled',
] as const;
export type JobStatusCode = (typeof JOB_STATUS_CODES)[number];

export function statusCode(status: JobStatus): JobStatusCode {
  return status.toLowerCase() as JobStatusCode;
}

const status = () => auditField.enumOf(JOB_STATUS_CODES);

export const courierAssignedAudit = defineAuditAction({
  action: 'dispatch.job.courier-assigned',
  targetType: 'dispatch.job',
  actors: ['authenticated'],
  before: { status: status(), courierId: auditField.optional(auditField.id()) },
  after: {
    status: status(),
    courierId: auditField.id(),
    vehicle: auditField.enumOf(VEHICLE_TYPES),
  },
});

export const offeringRestartedAudit = defineAuditAction({
  action: 'dispatch.job.offering-restarted',
  targetType: 'dispatch.job',
  actors: ['authenticated'],
  before: { status: status() },
  after: { status: status() },
});

export const DISPATCH_AUDIT_ACTIONS = [courierAssignedAudit, offeringRestartedAudit] as const;
