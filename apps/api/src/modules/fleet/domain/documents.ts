import type { Id, Temporal } from '@mondapac-drive/shared-kernel';
import type { DocumentRequirement } from './fleet-rules';
import type { EmploymentType } from './courier-status';
import type { Vehicle } from './vehicle';

/**
 * A document's review: submitted by the courier, then verified or rejected by an operator. A
 * rejected document stays rejected; the courier submits a new one.
 */
export const DOCUMENT_STATUSES = ['submitted', 'verified', 'rejected'] as const;
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number];

/** Why an operator rejected a document: codes, never free text. */
export const REJECTION_REASONS = [
  'illegible',
  'expired',
  'mismatch',
  'incomplete',
  'other',
] as const;
export type RejectionReason = (typeof REJECTION_REASONS)[number];

/** The file types a document may be uploaded as. */
export const DOCUMENT_MEDIA_TYPES = ['application/pdf', 'image/jpeg', 'image/png'] as const;
export type DocumentMediaType = (typeof DOCUMENT_MEDIA_TYPES)[number];

/**
 * A document a courier submitted. Only the object-store key of the file is kept: never a
 * document number, which stays in the file.
 */
export interface CourierDocument {
  readonly id: Id<'CourierDocument'>;
  /** The Market's code of the document (see `DocumentRequirement.type`). */
  readonly type: string;
  /** Set for a document of one vehicle. */
  readonly vehicleId?: Id<'Vehicle'>;
  readonly fileKey: string;
  readonly mediaType: DocumentMediaType;
  readonly expiresAt?: Temporal.Instant;
  readonly status: DocumentStatus;
  readonly submittedAt: Temporal.Instant;
  readonly reviewedAt?: Temporal.Instant;
  readonly rejectionReason?: RejectionReason;
}

/** Verified and not expired at `now`. */
export function isDocumentValid(document: CourierDocument, now: Temporal.Instant): boolean {
  if (document.status !== 'verified') return false;
  return (
    document.expiresAt === undefined || document.expiresAt.epochMilliseconds > now.epochMilliseconds
  );
}

/** Whether a requirement applies to a courier using `vehicle`, for a cold-chain job or not. */
export function requirementApplies(
  requirement: DocumentRequirement,
  employmentType: EmploymentType,
  vehicle: Vehicle,
  coldChain: boolean,
): boolean {
  if (requirement.coldChainOnly && !coldChain) return false;
  if (requirement.employmentTypes && !requirement.employmentTypes.includes(employmentType)) {
    return false;
  }
  if (requirement.vehicleTypes && !requirement.vehicleTypes.includes(vehicle.type)) return false;
  return true;
}

/** Whether a valid document meets the requirement for `vehicle`. */
export function requirementMet(
  requirement: DocumentRequirement,
  documents: readonly CourierDocument[],
  vehicle: Vehicle,
  now: Temporal.Instant,
): boolean {
  return documents.some(
    (document) =>
      document.type === requirement.type &&
      (!requirement.perVehicle || document.vehicleId === vehicle.id) &&
      isDocumentValid(document, now),
  );
}
