import { Temporal } from '@mondapac-drive/shared-kernel';
import { z } from 'zod';
import { COURIER_STATUSES, EMPLOYMENT_TYPES, SUSPENSION_REASONS } from '../domain/courier-status';
import { REJECTION_REASONS } from '../domain/documents';
import type { ShiftState } from '../domain/shift';
import { COLD_BOXES, VEHICLE_TYPES } from '../domain/vehicle';

// The request shapes of the fleet routes: strict objects, codes from the domain's lists, ids as
// UUIDs, instants with an offset. A refusal names the field, never its value.

const uuid = z.uuid().transform((value) => value.toLowerCase());
const instant = z.iso.datetime({ offset: true }).transform((value) => Temporal.Instant.from(value));
const grams = z.number().int().positive().max(5_000_000);
const litres = z.number().int().positive().max(50_000);
const serviceArea = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
const documentType = z.string().regex(/^[a-z][a-z0-9_]{1,39}$/);

export const applyBody = z.strictObject({
  employmentType: z.enum(EMPLOYMENT_TYPES),
  serviceAreaCode: serviceArea,
  coldChainCapable: z.boolean(),
});

/** A courier goes online, offline or on a break; dispatch alone puts them on a delivery. */
export const shiftBody = z.strictObject({
  state: z.enum(['offline', 'online', 'paused'] as const satisfies readonly ShiftState[]),
});

export const vehicleBody = z.strictObject({
  type: z.enum(VEHICLE_TYPES),
  plate: z.string().min(1).max(16).optional(),
  maxWeightGrams: grams.optional(),
  maxVolumeLitres: litres.optional(),
  coldBox: z.enum(COLD_BOXES),
});

/** The fields of a multipart document upload, beside the file. */
export const documentFields = z.strictObject({
  type: documentType,
  vehicleId: uuid.optional(),
  expiresAt: instant.optional(),
});

export const courierListQuery = z.strictObject({
  status: z.enum(COURIER_STATUSES).optional(),
  after: uuid.optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export const expiringDocumentsQuery = z.strictObject({
  before: instant,
  after: uuid.optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export const approveBody = z.strictObject({
  employmentType: z.enum(EMPLOYMENT_TYPES),
  coldChainCapable: z.boolean(),
});

export const suspendBody = z.strictObject({ reason: z.enum(SUSPENSION_REASONS) });

export const taxRegistrationBody = z.strictObject({ taxRegistered: z.boolean() });

export const verifyBody = z.strictObject({ expiresAt: instant.optional() });

export const refuseDocumentBody = z.strictObject({ reason: z.enum(REJECTION_REASONS) });

export const capacityBody = z.strictObject({ maxWeightGrams: grams, maxVolumeLitres: litres });
