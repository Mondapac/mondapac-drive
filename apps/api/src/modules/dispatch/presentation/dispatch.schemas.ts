import { z } from 'zod';
import { VEHICLE_TYPES } from '../domain/courier';

/** A dispatcher assigns or reassigns a delivery's courier, with the vehicle they carry it in. */
export const assignBody = z.strictObject({
  courierId: z.string().min(1).max(64),
  vehicle: z.enum(VEHICLE_TYPES),
});

/** An empty JSON body, or none: the answer routes take no input but the path. */
export const emptyBody = z.union([z.strictObject({}), z.undefined()]);
