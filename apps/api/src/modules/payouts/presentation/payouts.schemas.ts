import { z } from 'zod';
import { ADJUSTMENT_REASONS } from '../domain/ledger';
import { PAYOUT_LINE_STATUSES } from '../domain/payout-run';

/** Minor units as decimal text, signed, at most 16 digits (what the courier app sends too). */
const minorUnits = z.string().regex(/^-?(0|[1-9][0-9]{0,15})$/);

export const ID_PARAM = z.uuid();

export const statementQuery = z.strictObject({
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

export const adjustmentBody = z.strictObject({
  amount: z.strictObject({
    amount: minorUnits,
    currency: z.string().regex(/^[A-Z]{3}$/),
  }),
  reason: z.enum(ADJUSTMENT_REASONS),
  key: z.string().regex(/^[A-Za-z0-9._:-]{8,100}$/),
});

/** `status` is a comma-separated list of line statuses: `held,unresolved` by default. */
export const lineQuery = z.strictObject({
  status: z
    .string()
    .max(80)
    .default('held,unresolved')
    .transform((text) => text.split(','))
    .pipe(z.array(z.enum(PAYOUT_LINE_STATUSES)).min(1).max(PAYOUT_LINE_STATUSES.length)),
  courierId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  after: z.uuid().optional(),
});
