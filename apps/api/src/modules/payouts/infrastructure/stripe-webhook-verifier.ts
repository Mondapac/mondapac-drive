import { timingSafeEqual } from 'node:crypto';
import { err, ok, Temporal, type Result } from '@mondapac-drive/shared-kernel';
import { z } from 'zod';
import type { ProviderSecret } from '../../../platform/config/payment-provider';
import type { ProviderEvent, ProviderWebhookVerifier, WebhookRefusal } from '../application/ports';

/** How far a signature's timestamp may be from now, either way (Stripe's default). */
export const SIGNATURE_TOLERANCE_SECONDS = 300;
/** At most this many signatures are checked from one header. */
const MAX_SIGNATURES = 8;

const ID = z.string().regex(/^[A-Za-z0-9_]{1,64}$/);

const envelope = z.object({
  id: z.string().regex(/^evt_[A-Za-z0-9]{1,250}$/),
  type: z
    .string()
    .regex(/^[a-z0-9_]+(\.[a-z0-9_]+)+$/)
    .max(64),
  /** Unix seconds; required where it is acted on (an account update's order). */
  created: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  data: z.object({ object: z.record(z.string(), z.unknown()) }),
});
const account = z.object({ id: ID, payouts_enabled: z.boolean() });
const transfer = z.object({
  id: ID,
  amount_reversed: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  currency: z.string().regex(/^[a-z]{3}$/),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
/** What Drive writes into a transfer's metadata (RunPayouts); anything else is not Drive's. */
const MARKET_ID = /^[A-Z][A-Z0-9_]{1,7}$/;
const LINE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The metadata value `key` when it is text matching `pattern`. */
function metadataOf(
  metadata: Record<string, unknown> | undefined,
  key: string,
  pattern: RegExp,
): string | undefined {
  const value = metadata?.[key];
  return typeof value === 'string' && pattern.test(value) ? value : undefined;
}

/** The `t` and every `v1` of a `Stripe-Signature` header; undefined when malformed. */
function parseHeader(
  header: string,
): { readonly timestamp: number; readonly signatures: readonly Buffer[] } | undefined {
  let timestamp: number | undefined;
  const signatures: Buffer[] = [];
  for (const part of header.split(',')) {
    const [key, value, ...rest] = part.trim().split('=');
    if (value === undefined || rest.length > 0) return undefined;
    if (key === 't') {
      if (!/^[0-9]{1,12}$/.test(value)) return undefined;
      timestamp = Number(value);
    } else if (key === 'v1' && /^[0-9a-f]{64}$/.test(value)) {
      signatures.push(Buffer.from(value, 'hex'));
    }
  }
  if (timestamp === undefined || signatures.length === 0 || signatures.length > MAX_SIGNATURES) {
    return undefined;
  }
  return { timestamp, signatures };
}

/**
 * {@link ProviderWebhookVerifier} for Stripe: the `Stripe-Signature` header carries a timestamp
 * `t` and HMAC-SHA-256 signatures `v1` of `"<t>.<raw body>"`. The body is accepted when one
 * signature matches one configured secret (compared in constant time) and `t` is within
 * {@link SIGNATURE_TOLERANCE_SECONDS} of now, which bounds a replay; redeliveries inside that
 * window are caught by the handled-event log. Only then is the body parsed.
 */
export class StripeWebhookVerifier implements ProviderWebhookVerifier {
  constructor(private readonly secrets: readonly ProviderSecret[]) {}

  verify(
    rawBody: Buffer,
    signatureHeader: string | undefined,
    now: Temporal.Instant,
  ): Result<ProviderEvent, WebhookRefusal> {
    if (this.secrets.length === 0 || signatureHeader === undefined) {
      return err('signature-invalid');
    }
    const header = parseHeader(signatureHeader);
    if (header === undefined) return err('signature-invalid');
    const age = Math.abs(now.epochMilliseconds / 1000 - header.timestamp);
    if (age > SIGNATURE_TOLERANCE_SECONDS) return err('signature-invalid');

    const signed = Buffer.concat([Buffer.from(`${header.timestamp}.`, 'utf8'), rawBody]);
    const matches = this.secrets.some((secret) => {
      const expected = secret.sign(signed);
      return header.signatures.some(
        (signature) => signature.length === expected.length && timingSafeEqual(signature, expected),
      );
    });
    if (!matches) return err('signature-invalid');
    return parseEvent(rawBody);
  }
}

function parseEvent(rawBody: Buffer): Result<ProviderEvent, WebhookRefusal> {
  let json: unknown;
  try {
    json = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return err('payload-invalid');
  }
  const event = envelope.safeParse(json);
  if (!event.success) return err('payload-invalid');
  const { id, type, created } = event.data;
  const object = event.data.data.object;
  if (type === 'account.updated') {
    const parsed = account.safeParse(object);
    if (!parsed.success || created === undefined) return err('payload-invalid');
    return ok({
      kind: 'account-updated',
      id,
      type,
      accountId: parsed.data.id,
      payoutsEnabled: parsed.data.payouts_enabled,
      created: Temporal.Instant.fromEpochMilliseconds(created * 1000),
    });
  }
  if (type === 'transfer.reversed') {
    const parsed = transfer.safeParse(object);
    if (!parsed.success) return err('payload-invalid');
    const marketId = metadataOf(parsed.data.metadata, 'marketId', MARKET_ID);
    const payoutLineId = metadataOf(parsed.data.metadata, 'payoutLineId', LINE_ID);
    return ok({
      kind: 'transfer-reversed',
      id,
      type,
      transferId: parsed.data.id,
      amountReversed: BigInt(parsed.data.amount_reversed),
      currency: parsed.data.currency.toUpperCase(),
      ...(marketId === undefined ? {} : { marketId }),
      ...(payoutLineId === undefined ? {} : { payoutLineId }),
    });
  }
  return ok({ kind: 'ignored', id, type });
}
