import { z } from 'zod';

// The `payouts` section of a Market file, owned by the payouts module (Drive's addition to the
// marketplace's Market file, like `delivery`): courier earnings rules, the payout schedule, the
// contractor tax rules and the payment provider's account settings. Kept in its own file so each
// module's section changes without touching the others.

/** Vehicle types, as in the `delivery` section. */
const VEHICLES = ['bicycle', 'motorbike', 'car', 'van'] as const;

/** Minor units of the Market's settlement currency. */
const minor = z.number().int().nonnegative().max(10_000_000);
const minutes = z
  .number()
  .int()
  .nonnegative()
  .max(24 * 60);
const httpsUrl = z
  .url({ protocol: /^https$/ })
  .max(500)
  .refine((value) => !/[?#]/.test(value), 'must have no query or fragment');

export const payoutsSchema = z.strictObject({
  earnings: z
    .strictObject({
      vehicles: z.partialRecord(
        z.enum(VEHICLES),
        z.strictObject({ perDelivery: minor, perKm: minor }),
      ),
      coldChainBonus: z.strictObject({ ambient: minor, chilled: minor, frozen: minor }),
      waiting: z.strictObject({
        freeMinutes: minutes,
        perMinute: minor,
        maxPaidMinutes: minutes,
      }),
    })
    .refine((earnings) => Object.keys(earnings.vehicles).length > 0, {
      message: 'the earnings rules rate no vehicle',
      path: ['vehicles'],
    }),
  schedule: z.strictObject({
    cadence: z.enum(['weekly', 'daily']),
    /** ISO weekday, 1 (Monday) to 7. */
    weekday: z.number().int().min(1).max(7),
    time: z.string().regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/, 'must be "HH:MM"'),
  }),
  minimumPayout: minor,
  tax: z.strictObject({
    rateBps: z.number().int().min(0).max(5000),
    onTips: z.boolean(),
    businessIdRequired: z.boolean(),
  }),
  provider: z.strictObject({
    accountCountry: z.string().regex(/^[A-Z]{2}$/, 'must be an ISO 3166 alpha-2 code'),
    onboardingReturnUrl: httpsUrl,
    onboardingRefreshUrl: httpsUrl,
  }),
});
