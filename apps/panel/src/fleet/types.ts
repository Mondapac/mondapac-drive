// The fleet API's operator shapes (Drive, `fleet/admin`). A courier has a fleet id and an identity
// account id (`accountId`, the id payouts, delivery and the courier-account list use, 31b); the
// API never sends a document's storage key, and neither does the panel.

export const COURIER_STATUSES = ['applicant', 'active', 'suspended', 'offboarded'] as const;
export type CourierStatus = (typeof COURIER_STATUSES)[number];

export const EMPLOYMENT_TYPES = ['employee', 'contractor'] as const;
export type EmploymentType = (typeof EMPLOYMENT_TYPES)[number];

export const SUSPENSION_REASONS = ['documents', 'conduct', 'safety', 'other'] as const;
export type SuspensionReason = (typeof SUSPENSION_REASONS)[number];

export const REJECTION_REASONS = [
  'illegible',
  'expired',
  'mismatch',
  'incomplete',
  'cancelled',
  'fraudulent',
  'other',
] as const;
export type RejectionReason = (typeof REJECTION_REASONS)[number];

export type ShiftState = 'offline' | 'online' | 'on_delivery' | 'paused';
export type DocumentStatus = 'submitted' | 'verified' | 'rejected' | 'revoked';
export type VehicleType = 'bicycle' | 'motorbike' | 'car' | 'van';
export type ColdBox = 'none' | 'insulated' | 'refrigerated';

/** A row of the courier list. */
export interface CourierSummary {
  readonly id: string;
  /** The identity account id: the courier's name, payouts and deliveries are keyed by it. */
  readonly accountId: string;
  readonly activeDeliveryId: string | null;
  readonly status: CourierStatus;
  readonly employmentType: EmploymentType;
  readonly coldChainCapable: boolean;
  readonly taxRegistered: boolean;
  readonly serviceAreaCode: string;
  readonly shift: ShiftState;
  readonly createdAt: string;
  readonly activeVehicles: number;
  readonly documentsToReview: number;
}

export interface CourierListPage {
  readonly items: readonly CourierSummary[];
  readonly next: string | null;
}

export interface FleetVehicle {
  readonly id: string;
  readonly type: VehicleType;
  readonly plate: string | null;
  readonly maxWeightGrams: number;
  readonly maxVolumeLitres: number;
  readonly coldBox: ColdBox;
  readonly active: boolean;
}

export interface FleetDocument {
  readonly id: string;
  /** The Market's code of the document (its requirement list). */
  readonly type: string;
  readonly vehicleId: string | null;
  readonly mediaType: 'application/pdf' | 'image/jpeg' | 'image/png';
  readonly expiresAt: string | null;
  readonly status: DocumentStatus;
  readonly submittedAt: string;
  readonly reviewedAt: string | null;
  readonly rejectionReason: RejectionReason | null;
}

/** A courier with their vehicles and documents; every decision answers this. */
export interface FleetCourier {
  readonly id: string;
  readonly accountId: string;
  readonly activeDeliveryId: string | null;
  readonly status: CourierStatus;
  readonly employmentType: EmploymentType;
  readonly coldChainCapable: boolean;
  readonly taxRegistered: boolean;
  readonly serviceAreaCode: string;
  readonly shift: ShiftState;
  readonly idleSince: string | null;
  readonly createdAt: string;
  readonly vehicles: readonly FleetVehicle[];
  readonly documents: readonly FleetDocument[];
}

export const FLEET_PERMISSION = {
  courierView: 'fleet.courier.view',
  courierDecide: 'fleet.courier.decide',
  /** Verify, reject and revoke, and download a document's file (operators view only). */
  documentReview: 'fleet.document.review',
  vehicleManage: 'fleet.vehicle.manage',
} as const;

/** The list's tabs: applicants first, as they wait for a decision. */
export const COURIER_FILTERS = ['applicant', 'active', 'suspended', 'offboarded', 'all'] as const;
export type CourierFilter = (typeof COURIER_FILTERS)[number];

/** The capacity limits the API takes (whole grams and litres). */
export const CAPACITY_LIMITS = { maxWeightGrams: 5_000_000, maxVolumeLitres: 50_000 } as const;

/** A row of `GET fleet/admin/documents/expiring` (verified documents, soonest first). */
export interface ExpiringDocument {
  readonly documentId: string;
  readonly courierId: string;
  readonly accountId: string;
  readonly type: string;
  readonly expiresAt: string;
}
