import { err, ok, type Result } from '@mondapac-drive/shared-kernel';
import type { SmsKind } from './delivery-change';
import type { RetryPolicy } from './outbound-message';

/** A Market's recipient SMS settings (`notifications.sms` of its Market file). */
export interface SmsSettings {
  /** The alphanumeric sender id or E.164 number messages come from. */
  readonly senderId: string;
  /** Appended to every message, after one space. */
  readonly optOutText: string;
  readonly maxAttempts: number;
  /** The country calling codes recipients may have (SMS pumping control), e.g. `61`. */
  readonly allowedCallingCodes: readonly string[];
  readonly templates: Readonly<Record<SmsKind, string>>;
}

/** The values a template may name; the tracking link exists only once tracking issued one. */
export interface SmsValues {
  readonly reference: string;
  readonly trackingUrl?: string;
}

export type SmsRenderError = 'sms.tracking-link-missing';

/** The longest reference a message shows; a merchant's reference is cut to this. */
export const MAX_SMS_REFERENCE_LENGTH = 32;

/**
 * The merchant's order reference as a message may show it: letters, digits and `-_#` only, at
 * most {@link MAX_SMS_REFERENCE_LENGTH} characters. A reference is merchant text: without dots,
 * slashes and colons no phone turns it into a link (`pay-now.io/x`), and line breaks and
 * look-alike characters stay out of a message sent in Drive's name.
 */
export function safeReference(reference: string): string {
  return reference.replace(/[^A-Za-z0-9\-_#]/g, '').slice(0, MAX_SMS_REFERENCE_LENGTH);
}

/**
 * The text of one recipient SMS: the Market's template of `kind` with its placeholders filled,
 * then the opt-out text. A template that names `{trackingUrl}` cannot be sent without a link.
 */
export function renderSms(
  settings: SmsSettings,
  kind: SmsKind,
  values: SmsValues,
): Result<string, SmsRenderError> {
  const template = settings.templates[kind];
  if (template.includes('{trackingUrl}') && values.trackingUrl === undefined) {
    return err('sms.tracking-link-missing');
  }
  const filled = template
    .replaceAll('{reference}', safeReference(values.reference))
    .replaceAll('{trackingUrl}', values.trackingUrl ?? '');
  return ok(`${filled} ${settings.optOutText}`);
}

/** The retry rules of SMS: the Market's attempts, then 30 s doubling to 30 min. */
export function smsRetryPolicy(settings: SmsSettings): RetryPolicy {
  return { maxAttempts: settings.maxAttempts, firstRetrySeconds: 30, maxRetrySeconds: 1800 };
}

/** A phone number in E.164 form (`+` and 7 to 15 digits). Personal data: never logged or stored here. */
export type PhoneNumber = string & { readonly __brand: 'PhoneNumber' };

/**
 * A recipient number as an SMS provider takes it. Spaces, dots, dashes and brackets are
 * dropped; the number must then be international (`+` and country code), since a national
 * form would need the Market's numbering plan.
 */
export function parsePhoneNumber(raw: string): PhoneNumber | undefined {
  const compact = raw.replace(/[\s().-]/g, '');
  return /^\+[1-9][0-9]{6,14}$/.test(compact) ? (compact as PhoneNumber) : undefined;
}

/**
 * Whether a number is in a country the Market sends SMS to. Numbers elsewhere are refused, so a
 * booking with a premium-rate foreign number cannot make Drive pay for messages (SMS pumping).
 */
export function isAllowedRecipient(settings: SmsSettings, phone: PhoneNumber): boolean {
  return settings.allowedCallingCodes.some((code) => phone.startsWith(`+${code}`));
}
