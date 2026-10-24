import type { Id, MarketId, PendingEvent, Temporal } from '@mondapac-drive/shared-kernel';
import {
  EMPLOYMENT_TYPES,
  SUSPENSION_REASONS,
  type CourierStatus,
  type EmploymentType,
  type SuspensionReason,
} from './courier-status';
import {
  DOCUMENT_MEDIA_TYPES,
  REJECTION_REASONS,
  type CourierDocument,
  type DocumentMediaType,
  type RejectionReason,
} from './documents';
import { eligibleVehicleTypes } from './eligibility';
import { FleetDomainError } from './errors';
import { courierSuspended, courierWentOffline, courierWentOnline } from './events';
import type { MarketFleetRules } from './fleet-rules';
import { assertShiftChange, type ShiftState } from './shift';
import { newVehicle, type NewVehicle } from './vehicle';
import type { CourierState } from './courier-state';

export type { CourierState } from './courier-state';

/** The most vehicles and documents one courier keeps: a bound, never a business number. */
export const MAX_VEHICLES = 10;
export const MAX_DOCUMENTS = 100;

/** A changed courier and the events the change publishes (at most one per version). */
export interface CourierChange {
  readonly courier: CourierState;
  readonly events: readonly PendingEvent[];
}

export interface NewCourier {
  readonly id: Id<'Courier'>;
  readonly marketId: MarketId;
  readonly actorId: string;
  readonly employmentType: EmploymentType;
  readonly serviceAreaCode: string;
  readonly coldChainCapable: boolean;
  readonly createdAt: Temporal.Instant;
}

/** A courier who applied: not yet approved, offline, with no vehicle or document. */
export function registerCourier(input: NewCourier): CourierState {
  if (!(EMPLOYMENT_TYPES as readonly string[]).includes(input.employmentType)) {
    throw new FleetDomainError('fleet.courier.employment-type-unknown', 'Unknown employment type');
  }
  return {
    id: input.id,
    marketId: input.marketId,
    actorId: input.actorId,
    employmentType: input.employmentType,
    status: 'applicant',
    serviceAreaCode: input.serviceAreaCode,
    coldChainCapable: input.coldChainCapable,
    shift: 'offline',
    vehicles: [],
    documents: [],
    createdAt: input.createdAt,
    version: 1,
  };
}

const next = (courier: CourierState, patch: Partial<CourierState>): CourierState => ({
  ...courier,
  ...patch,
  version: courier.version + 1,
});

const unchanged = (courier: CourierState): CourierChange => ({ courier, events: [] });

function requireStatus(courier: CourierState, allowed: readonly CourierStatus[], code: string) {
  if (!allowed.includes(courier.status)) {
    throw new FleetDomainError(code, `Not allowed for a courier who is ${courier.status}`);
  }
}

function requireEligible(courier: CourierState, rules: MarketFleetRules, now: Temporal.Instant) {
  if (eligibleVehicleTypes(courier, rules, now, false).length === 0) {
    throw new FleetDomainError(
      'fleet.courier.not-eligible',
      'The courier has no vehicle whose required documents are all verified and current',
    );
  }
}

// --- Operator decisions ---------------------------------------------------------------------

/**
 * What the operator confirmed when approving: the courier declares their employment type and
 * cold-chain capability when applying, but those decide which documents are required, so the
 * operator sets them from the contract and training records.
 */
export interface ConfirmedTerms {
  readonly employmentType: EmploymentType;
  readonly coldChainCapable: boolean;
}

/** Approves an applicant on the terms the operator confirmed, once they make a vehicle eligible. */
export function approveCourier(
  courier: CourierState,
  terms: ConfirmedTerms,
  rules: MarketFleetRules,
  now: Temporal.Instant,
): CourierChange {
  requireStatus(courier, ['applicant'], 'fleet.courier.not-an-applicant');
  if (!(EMPLOYMENT_TYPES as readonly string[]).includes(terms.employmentType)) {
    throw new FleetDomainError('fleet.courier.employment-type-unknown', 'Unknown employment type');
  }
  const confirmed: CourierState = {
    ...courier,
    employmentType: terms.employmentType,
    coldChainCapable: terms.coldChainCapable,
  };
  requireEligible(confirmed, rules, now);
  return unchanged(next(confirmed, { status: 'active' }));
}

/** Suspends an active courier, which also ends their shift. */
export function suspendCourier(
  courier: CourierState,
  reason: SuspensionReason,
  now: Temporal.Instant,
): CourierChange {
  if (!(SUSPENSION_REASONS as readonly string[]).includes(reason)) {
    throw new FleetDomainError('fleet.courier.suspension-reason-unknown', 'Unknown reason');
  }
  requireStatus(courier, ['active'], 'fleet.courier.not-active');
  const changed = next(courier, { status: 'suspended', shift: 'offline' });
  return {
    courier: changed,
    events: [
      courierSuspended.record({
        aggregateId: courier.id,
        aggregateVersion: changed.version,
        occurredAt: now,
        payload: { courierId: courier.id, wasOnline: courier.shift !== 'offline' },
      }),
    ],
  };
}

/** Reinstates a suspended courier whose documents still make them eligible now. */
export function reinstateCourier(
  courier: CourierState,
  rules: MarketFleetRules,
  now: Temporal.Instant,
): CourierChange {
  requireStatus(courier, ['suspended'], 'fleet.courier.not-suspended');
  requireEligible(courier, rules, now);
  return unchanged(next(courier, { status: 'active' }));
}

/** Ends the courier's work with the operator for good, and their shift with it. */
export function offboardCourier(courier: CourierState, now: Temporal.Instant): CourierChange {
  requireStatus(courier, ['applicant', 'active', 'suspended'], 'fleet.courier.offboarded');
  const changed = next(courier, { status: 'offboarded', shift: 'offline' });
  return {
    courier: changed,
    events:
      courier.shift === 'offline'
        ? []
        : [
            courierWentOffline.record({
              aggregateId: courier.id,
              aggregateVersion: changed.version,
              occurredAt: now,
              payload: { courierId: courier.id, cause: 'offboarded' },
            }),
          ],
  };
}

// --- Vehicles -------------------------------------------------------------------------------

export function addVehicle(courier: CourierState, input: NewVehicle): CourierChange {
  requireStatus(courier, ['applicant', 'active', 'suspended'], 'fleet.courier.offboarded');
  if (courier.vehicles.length >= MAX_VEHICLES) {
    throw new FleetDomainError('fleet.vehicle.too-many', `At most ${MAX_VEHICLES} vehicles`);
  }
  const vehicle = newVehicle(input);
  if (
    vehicle.plate !== undefined &&
    courier.vehicles.some((other) => other.active && other.plate === vehicle.plate)
  ) {
    throw new FleetDomainError('fleet.vehicle.plate-taken', 'The courier already has this plate');
  }
  return unchanged(next(courier, { vehicles: [...courier.vehicles, vehicle] }));
}

/** Takes a vehicle out of use. A courier on a delivery keeps at least the vehicle in use. */
export function deactivateVehicle(courier: CourierState, vehicleId: Id<'Vehicle'>): CourierChange {
  const vehicle = courier.vehicles.find((candidate) => candidate.id === vehicleId);
  if (vehicle === undefined) {
    throw new FleetDomainError('fleet.vehicle.not-found', 'No such vehicle');
  }
  if (!vehicle.active) return unchanged(courier);
  if (courier.shift === 'on_delivery') {
    throw new FleetDomainError(
      'fleet.vehicle.in-use',
      'A courier on a delivery changes vehicles after it',
    );
  }
  return unchanged(
    next(courier, {
      vehicles: courier.vehicles.map((v) => (v.id === vehicleId ? { ...v, active: false } : v)),
    }),
  );
}

// --- Documents ------------------------------------------------------------------------------

export interface SubmittedDocument {
  readonly id: Id<'CourierDocument'>;
  readonly type: string;
  readonly vehicleId?: Id<'Vehicle'>;
  readonly fileKey: string;
  readonly mediaType: DocumentMediaType;
  readonly expiresAt?: Temporal.Instant;
}

/**
 * Records a document for review. The Market must require its type; a vehicle document names
 * one of the courier's vehicles, a courier document none; a document that expires has an
 * expiry after `now`, one that does not has none.
 */
export function submitDocument(
  courier: CourierState,
  input: SubmittedDocument,
  rules: MarketFleetRules,
  now: Temporal.Instant,
): CourierChange {
  requireStatus(courier, ['applicant', 'active', 'suspended'], 'fleet.courier.offboarded');
  if (courier.documents.length >= MAX_DOCUMENTS) {
    throw new FleetDomainError('fleet.document.too-many', `At most ${MAX_DOCUMENTS} documents`);
  }
  const requirement = rules.documents.find((candidate) => candidate.type === input.type);
  if (requirement === undefined) {
    throw new FleetDomainError(
      'fleet.document.type-unknown',
      'The Market asks for no such document',
    );
  }
  if (!(DOCUMENT_MEDIA_TYPES as readonly string[]).includes(input.mediaType)) {
    throw new FleetDomainError('fleet.document.media-type', 'A document is a PDF, JPEG or PNG');
  }
  if (requirement.perVehicle) {
    if (!courier.vehicles.some((vehicle) => vehicle.id === input.vehicleId)) {
      throw new FleetDomainError(
        'fleet.document.vehicle-required',
        'This document belongs to one of the courier’s vehicles',
      );
    }
  } else if (input.vehicleId !== undefined) {
    throw new FleetDomainError(
      'fleet.document.vehicle-not-allowed',
      'This document belongs to the courier, not a vehicle',
    );
  }
  if (requirement.expires) {
    if (input.expiresAt === undefined) {
      throw new FleetDomainError('fleet.document.expiry-required', 'Give the expiry date');
    }
    if (input.expiresAt.epochMilliseconds <= now.epochMilliseconds) {
      throw new FleetDomainError('fleet.document.expired', 'The document has expired');
    }
  } else if (input.expiresAt !== undefined) {
    throw new FleetDomainError(
      'fleet.document.expiry-not-allowed',
      'This document does not expire',
    );
  }
  const document: CourierDocument = {
    id: input.id,
    type: input.type,
    ...(input.vehicleId === undefined ? {} : { vehicleId: input.vehicleId }),
    fileKey: input.fileKey,
    mediaType: input.mediaType,
    ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
    status: 'submitted',
    submittedAt: now,
  };
  return unchanged(next(courier, { documents: [...courier.documents, document] }));
}

function reviewed(
  courier: CourierState,
  documentId: Id<'CourierDocument'>,
  review: (document: CourierDocument) => CourierDocument,
  from: CourierDocument['status'] = 'submitted',
): CourierState {
  const document = courier.documents.find((candidate) => candidate.id === documentId);
  if (document === undefined) {
    throw new FleetDomainError('fleet.document.not-found', 'No such document');
  }
  if (document.status !== from) {
    throw new FleetDomainError(
      from === 'submitted' ? 'fleet.document.already-reviewed' : 'fleet.document.not-verified',
      `The document is ${document.status}`,
    );
  }
  return next(courier, {
    documents: courier.documents.map((d) => (d.id === documentId ? review(d) : d)),
  });
}

/**
 * An operator checked the file against the original: it counts from now until it expires. For
 * a document that expires, the operator gives the expiry they read on it, which replaces the
 * one the courier declared.
 */
export function verifyDocument(
  courier: CourierState,
  documentId: Id<'CourierDocument'>,
  confirmedExpiresAt: Temporal.Instant | undefined,
  now: Temporal.Instant,
): CourierChange {
  return unchanged(
    reviewed(courier, documentId, (document) => {
      if (document.expiresAt === undefined) {
        if (confirmedExpiresAt !== undefined) {
          throw new FleetDomainError(
            'fleet.document.expiry-not-allowed',
            'This document does not expire',
          );
        }
        return { ...document, status: 'verified', reviewedAt: now };
      }
      if (confirmedExpiresAt === undefined) {
        throw new FleetDomainError('fleet.document.expiry-required', 'Confirm the expiry date');
      }
      if (confirmedExpiresAt.epochMilliseconds <= now.epochMilliseconds) {
        throw new FleetDomainError('fleet.document.expired', 'The document has expired');
      }
      return { ...document, expiresAt: confirmedExpiresAt, status: 'verified', reviewedAt: now };
    }),
  );
}

/** An operator withdraws a verified document that was cancelled or found false. */
export function revokeDocument(
  courier: CourierState,
  documentId: Id<'CourierDocument'>,
  reason: RejectionReason,
  now: Temporal.Instant,
): CourierChange {
  if (!(REJECTION_REASONS as readonly string[]).includes(reason)) {
    throw new FleetDomainError('fleet.document.rejection-reason-unknown', 'Unknown reason');
  }
  return unchanged(
    reviewed(
      courier,
      documentId,
      (document) => ({ ...document, status: 'revoked', reviewedAt: now, rejectionReason: reason }),
      'verified',
    ),
  );
}

export function rejectDocument(
  courier: CourierState,
  documentId: Id<'CourierDocument'>,
  reason: RejectionReason,
  now: Temporal.Instant,
): CourierChange {
  if (!(REJECTION_REASONS as readonly string[]).includes(reason)) {
    throw new FleetDomainError('fleet.document.rejection-reason-unknown', 'Unknown reason');
  }
  return unchanged(
    reviewed(courier, documentId, (document) => ({
      ...document,
      status: 'rejected',
      reviewedAt: now,
      rejectionReason: reason,
    })),
  );
}

// --- Shift ----------------------------------------------------------------------------------

/**
 * The courier changes their shift. Only an active courier works shifts, and going online (also
 * back from a pause) needs a vehicle they are eligible for now. Going online from offline and
 * going offline publish an event; a pause and a delivery do not.
 */
export function changeShift(
  courier: CourierState,
  to: ShiftState,
  rules: MarketFleetRules,
  now: Temporal.Instant,
): CourierChange {
  requireStatus(courier, ['active'], 'fleet.courier.not-active');
  if (courier.shift === to) return unchanged(courier);
  assertShiftChange(courier.shift, to);
  if (to === 'online' && courier.shift !== 'on_delivery') requireEligible(courier, rules, now);
  const changed = next(courier, { shift: to });
  const events: PendingEvent[] = [];
  if (courier.shift === 'offline' && to === 'online') {
    events.push(
      courierWentOnline.record({
        aggregateId: courier.id,
        aggregateVersion: changed.version,
        occurredAt: now,
        payload: { courierId: courier.id },
      }),
    );
  } else if (to === 'offline') {
    events.push(
      courierWentOffline.record({
        aggregateId: courier.id,
        aggregateVersion: changed.version,
        occurredAt: now,
        payload: { courierId: courier.id, cause: 'courier' },
      }),
    );
  }
  return { courier: changed, events };
}
