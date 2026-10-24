/** The hybrid fleet: couriers employed by the operator and independent contractors. */
export const EMPLOYMENT_TYPES = ['employee', 'contractor'] as const;
export type EmploymentType = (typeof EMPLOYMENT_TYPES)[number];

/**
 * A courier's standing with the operator. An applicant is approved into active; an active
 * courier can be suspended and reinstated; offboarded is final.
 */
export const COURIER_STATUSES = ['applicant', 'active', 'suspended', 'offboarded'] as const;
export type CourierStatus = (typeof COURIER_STATUSES)[number];

/** Why an operator suspended a courier: codes, never free text (no personal data in the log). */
export const SUSPENSION_REASONS = ['documents', 'conduct', 'safety', 'other'] as const;
export type SuspensionReason = (typeof SUSPENSION_REASONS)[number];
