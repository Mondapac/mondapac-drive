import { z } from 'zod';

/** The recipient SMS a delivery sends, in lifecycle order (notifications module). */
export const SMS_KINDS = ['booked', 'on_the_way', 'delivered', 'failed'] as const;

/** The values a template may name, as `{name}`; anything else is refused at start-up. */
export const SMS_PLACEHOLDERS = ['reference', 'trackingUrl'] as const;

const PLACEHOLDER = /\{([^{}]*)\}/g;
const KNOWN = new Set<string>(SMS_PLACEHOLDERS);

/** One template: plain text, at most three SMS segments, naming only known placeholders. */
const smsTemplate = z
  .string()
  .min(1)
  .max(400)
  .refine(
    (value) => [...value].every((character) => character >= ' ' && character !== '\u007f'),
    'must not hold control characters',
  )
  .refine(
    (value) => [...value.matchAll(PLACEHOLDER)].every((match) => KNOWN.has(match[1] ?? '')),
    `may name only ${SMS_PLACEHOLDERS.map((name) => `{${name}}`).join(', ')}`,
  )
  .refine((value) => value.replace(PLACEHOLDER, '').search(/[{}]/) === -1, 'has an unpaired brace');

/**
 * The `notifications` section, owned by the notifications module: merchant webhook retries and
 * the recipient SMS of each Market. `sms.senderId` is the alphanumeric sender id (at most 11
 * characters, letters first) or an E.164 number; `optOutText` is appended to every message.
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
  }),
});
