import { z } from 'zod';

/** The recipient SMS a delivery sends, in lifecycle order (notifications module). */
export const SMS_KINDS = ['booked', 'on_the_way', 'delivered', 'failed'] as const;

/** The values a template may name, as `{name}`; anything else is refused at start-up. */
export const SMS_PLACEHOLDERS = ['reference', 'trackingUrl'] as const;

const PLACEHOLDER = /\{([^{}]*)\}/g;

/** Plain text of at most `max` characters, naming only the given placeholders. */
function textNaming(placeholders: readonly string[], max: number) {
  const known = new Set<string>(placeholders);
  return z
    .string()
    .min(1)
    .max(max)
    .refine(
      (value) => [...value].every((character) => character >= ' ' && character !== '\u007f'),
      'must not hold control characters',
    )
    .refine(
      (value) => [...value.matchAll(PLACEHOLDER)].every((match) => known.has(match[1] ?? '')),
      `may name only ${placeholders.map((name) => `{${name}}`).join(', ')}`,
    )
    .refine(
      (value) => value.replace(PLACEHOLDER, '').search(/[{}]/) === -1,
      'has an unpaired brace',
    );
}

/** One template: plain text, at most three SMS segments, naming only known placeholders. */
const smsTemplate = textNaming(SMS_PLACEHOLDERS, 400);

/** The PIN sentence added to the booked message: it names `{pin}` exactly once. */
const pinText = textNaming(['pin'], 80).refine(
  (value) => value.split('{pin}').length === 2,
  'must name {pin} exactly once',
);

/** The customer tracking page: an https URL with `{token}` once, in its path or query. */
const trackingPageUrl = z
  .string()
  .max(200)
  .refine((value) => value.split('{token}').length === 2, 'must name {token} exactly once')
  .refine((value) => {
    try {
      const url = new URL(value.replace('{token}', 'token'));
      return url.protocol === 'https:' && url.username === '' && url.password === '';
    } catch {
      return false;
    }
  }, 'must be an https URL without credentials');

/**
 * The `notifications` section, owned by the notifications module: merchant webhook retries and
 * the recipient SMS of each Market. `sms.senderId` is the alphanumeric sender id (at most 11
 * characters, letters first) or an E.164 number; `optOutText` is appended to every message,
 * `pinText` to the booked one when the delivery has a PIN; `trackingPageUrl` is the customer
 * page a tracking link token opens.
 */
export const notificationsSchema = z.strictObject({
  webhooks: z
    .strictObject({
      /** Attempts before a delivery is dead-lettered for an operator to re-send. */
      maxAttempts: z.number().int().min(1).max(20),
      /** The wait after the first failed attempt; doubled after each further failure. */
      firstRetrySeconds: z.number().int().min(5).max(3600),
      /** The longest wait between two attempts. */
      maxRetrySeconds: z.number().int().min(5).max(86_400),
      /**
       * After a secret rotation, how long the previous secret still signs next to the new one
       * (both `v1=` entries), so the merchant can switch its receiver. 0 ends it at once.
       */
      rotationOverlapMinutes: z
        .number()
        .int()
        .min(0)
        .max(7 * 24 * 60),
    })
    .refine((webhooks) => webhooks.maxRetrySeconds >= webhooks.firstRetrySeconds, {
      message: 'maxRetrySeconds must be at least firstRetrySeconds',
      path: ['maxRetrySeconds'],
    }),
  sms: z.strictObject({
    senderId: z.string().regex(/^(?:[A-Za-z][A-Za-z0-9 ]{0,10}|\+[1-9][0-9]{6,14})$/, {
      message: 'must be an alphanumeric sender id of up to 11 characters or an E.164 number',
    }),
    optOutText: z.string().min(1).max(60),
    maxAttempts: z.number().int().min(1).max(10),
    /** Country calling codes recipients may have; any other number is refused (SMS pumping). */
    allowedCallingCodes: z
      .array(z.string().regex(/^[1-9][0-9]{0,2}$/, 'must be a country calling code such as 61'))
      .min(1),
    templates: z.strictObject({
      booked: smsTemplate,
      on_the_way: smsTemplate,
      delivered: smsTemplate,
      failed: smsTemplate,
    }),
    pinText,
    trackingPageUrl,
  }),
});
