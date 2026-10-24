import { createHmac } from 'node:crypto';
import { inspect } from 'node:util';

/**
 * A payment-provider credential. Its text never leaves this object by accident: it is printed,
 * inspected and serialised as a fixed marker, so a configuration object that reaches a log
 * carries no key. Only the provider adapter reads it, through `reveal` or `sign`.
 */
export class ProviderSecret {
  readonly #text: string;

  constructor(text: string) {
    this.#text = text;
  }

  /** The credential itself, for the provider's Authorization header. */
  reveal(): string {
    return this.#text;
  }

  /** HMAC-SHA-256 of `message` under this secret, as the provider signs its webhooks. */
  sign(message: Buffer): Buffer {
    return createHmac('sha256', this.#text).update(message).digest();
  }

  toString(): string {
    return '[secret]';
  }

  toJSON(): string {
    return '[secret]';
  }

  [inspect.custom](): string {
    return '[secret]';
  }
}

/**
 * The payment provider of courier payouts (Stripe Connect), from `STRIPE_SECRET_KEY` and
 * `STRIPE_WEBHOOK_SECRETS` (comma-separated: the platform endpoint's secret and the Connect
 * endpoint's, and an old one while rotating). Both set or both unset; unset turns payouts' calls
 * to the provider off.
 */
export interface PaymentProviderConfig {
  readonly secretKey: ProviderSecret;
  readonly webhookSecrets: readonly ProviderSecret[];
}

const SECRET_KEY = /^(sk|rk)_(test|live)_[A-Za-z0-9]{10,}$/;
const WEBHOOK_SECRET = /^whsec_[A-Za-z0-9+/=]{10,}$/;

/**
 * Parses the provider variables. Issues name the variable and never echo a value. A live key is
 * refused unless `NODE_ENV` is production, so a development or test process never moves money.
 */
export function parsePaymentProvider(
  secretKey: string | undefined,
  webhookSecrets: string | undefined,
  nodeEnv: string | undefined,
): { readonly config: PaymentProviderConfig | null; readonly issues: readonly string[] } {
  const key = secretKey?.trim() ?? '';
  const hooks = (webhookSecrets ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  if (key === '' && hooks.length === 0) return { config: null, issues: [] };
  const issues: string[] = [];
  if (!SECRET_KEY.test(key)) {
    issues.push('STRIPE_SECRET_KEY: must be a Stripe secret or restricted key');
  } else if (key.includes('_live_') && nodeEnv !== 'production') {
    issues.push('STRIPE_SECRET_KEY: a live key is accepted only when NODE_ENV is production');
  }
  if (hooks.length === 0 || hooks.length > 4 || !hooks.every((hook) => WEBHOOK_SECRET.test(hook))) {
    issues.push('STRIPE_WEBHOOK_SECRETS: must list one to four Stripe webhook signing secrets');
  }
  if (issues.length > 0) return { config: null, issues };
  return {
    config: Object.freeze({
      secretKey: new ProviderSecret(key),
      webhookSecrets: Object.freeze(hooks.map((hook) => new ProviderSecret(hook))),
    }),
    issues: [],
  };
}
