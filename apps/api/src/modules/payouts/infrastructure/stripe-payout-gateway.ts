import { err, ok, Temporal, type Result } from '@mondapac-drive/shared-kernel';
import type { ProviderSecret } from '../../../platform/config/payment-provider';
import type { GatewayRefusal, PayoutGateway } from '../application/ports';

/** One HTTPS call to the provider, and its answer. */
export interface HttpRequest {
  readonly method: 'POST';
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}
export interface HttpResponse {
  readonly status: number;
  readonly body: string;
}
/** Sends one request; throws on a network failure or a timeout. */
export type HttpTransport = (request: HttpRequest) => Promise<HttpResponse>;

const API = 'https://api.stripe.com/v1';
const TIMEOUT_MS = 10_000;

/** The transport of a running process: `fetch`, with a timeout and no redirects. */
export const fetchTransport: HttpTransport = async (request) => {
  const response = await fetch(request.url, {
    method: request.method,
    headers: request.headers,
    body: request.body,
    redirect: 'error',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  return { status: response.status, body: await response.text() };
};

/**
 * Currencies whose amounts Stripe counts differently from ISO 4217 minor units (Stripe's
 * "special cases"). Drive's minor units are ISO's, so a transfer in one of them is refused
 * rather than sent with a wrong amount.
 */
const UNSUPPORTED_CURRENCIES = new Set(['HUF', 'ISK', 'TWD', 'UGX']);

const ID = /^[A-Za-z0-9_]{1,64}$/;

/** Form fields as Stripe takes them: text, or nested fields written as `key[inner]`. */
interface FormFields {
  readonly [key: string]: string | FormFields;
}

/** Stripe's form encoding: nested keys in brackets, values as text. */
function form(fields: FormFields, params = new URLSearchParams(), prefix = ''): string {
  for (const [key, value] of Object.entries(fields)) {
    const name = prefix === '' ? key : `${prefix}[${key}]`;
    if (typeof value === 'string') params.append(name, value);
    else form(value, params, name);
  }
  return params.toString();
}

function parseJson(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** A refusal from Stripe's answer: its error code or type, never its message (it may echo input). */
function refusalOf(response: HttpResponse): GatewayRefusal {
  const transient = response.status === 429 || response.status >= 500 || response.status === 409;
  const error = parseJson(response.body)?.error as Record<string, unknown> | undefined;
  const raw = typeof error?.code === 'string' ? error.code : error?.type;
  const code = typeof raw === 'string' && /^[a-z0-9_]{1,48}$/.test(raw) ? raw : 'unknown';
  return { code: `stripe.${code}`, transient };
}

/**
 * {@link PayoutGateway} on Stripe Connect: Express accounts for couriers, account links for
 * their onboarding, and transfers from the platform balance. It speaks Stripe's REST API through
 * an injected transport (a fake in tests). Every create carries an `Idempotency-Key`, so a retry
 * after a timeout never creates twice. Nothing but ids and amounts is sent or kept: Stripe
 * collects the courier's identity and bank details on its own pages.
 */
export class StripePayoutGateway implements PayoutGateway {
  readonly enabled = true;

  constructor(
    private readonly secretKey: ProviderSecret,
    private readonly transport: HttpTransport = fetchTransport,
  ) {}

  async createAccount(request: {
    readonly country: string;
    readonly idempotencyKey: string;
    readonly metadata: Readonly<Record<string, string>>;
  }): Promise<Result<{ readonly accountId: string }, GatewayRefusal>> {
    const answer = await this.post(
      '/accounts',
      {
        type: 'express',
        country: request.country,
        capabilities: { transfers: { requested: 'true' } },
        metadata: request.metadata,
      },
      request.idempotencyKey,
    );
    if (!answer.ok) return answer;
    const id = answer.value.id;
    return typeof id === 'string' && ID.test(id)
      ? ok({ accountId: id })
      : err({ code: 'stripe.malformed-answer', transient: true });
  }

  async createOnboardingLink(request: {
    readonly accountId: string;
    readonly returnUrl: string;
    readonly refreshUrl: string;
  }): Promise<
    Result<{ readonly url: string; readonly expiresAt: Temporal.Instant }, GatewayRefusal>
  > {
    const answer = await this.post('/account_links', {
      account: request.accountId,
      type: 'account_onboarding',
      return_url: request.returnUrl,
      refresh_url: request.refreshUrl,
    });
    if (!answer.ok) return answer;
    const { url, expires_at: expiresAt } = answer.value;
    if (
      typeof url !== 'string' ||
      !url.startsWith('https://connect.stripe.com/') ||
      typeof expiresAt !== 'number' ||
      !Number.isSafeInteger(expiresAt)
    ) {
      return err({ code: 'stripe.malformed-answer', transient: true });
    }
    return ok({ url, expiresAt: Temporal.Instant.fromEpochMilliseconds(expiresAt * 1000) });
  }

  async createTransfer(request: {
    readonly amount: { readonly amount: bigint; readonly currency: string };
    readonly destination: string;
    readonly idempotencyKey: string;
    readonly metadata: Readonly<Record<string, string>>;
  }): Promise<Result<{ readonly transferId: string }, GatewayRefusal>> {
    if (UNSUPPORTED_CURRENCIES.has(request.amount.currency) || request.amount.amount <= 0n) {
      return err({ code: 'stripe.unsupported-amount', transient: false });
    }
    const answer = await this.post(
      '/transfers',
      {
        amount: request.amount.amount.toString(),
        currency: request.amount.currency.toLowerCase(),
        destination: request.destination,
        ...(request.metadata.runId === undefined ? {} : { transfer_group: request.metadata.runId }),
        metadata: request.metadata,
      },
      request.idempotencyKey,
    );
    if (!answer.ok) return answer;
    const id = answer.value.id;
    return typeof id === 'string' && ID.test(id)
      ? ok({ transferId: id })
      : err({ code: 'stripe.malformed-answer', transient: true });
  }

  private async post(
    path: string,
    fields: FormFields,
    idempotencyKey?: string,
  ): Promise<Result<Record<string, unknown>, GatewayRefusal>> {
    let response: HttpResponse;
    try {
      response = await this.transport({
        method: 'POST',
        url: `${API}${path}`,
        headers: {
          authorization: `Bearer ${this.secretKey.reveal()}`,
          'content-type': 'application/x-www-form-urlencoded',
          ...(idempotencyKey === undefined ? {} : { 'idempotency-key': idempotencyKey }),
        },
        body: form(fields),
      });
    } catch {
      // A timeout or a lost connection: the request may have been applied, so it is retried
      // with the same idempotency key.
      return err({ code: 'stripe.unreachable', transient: true });
    }
    if (response.status < 200 || response.status >= 300) return err(refusalOf(response));
    const body = parseJson(response.body);
    return body === undefined
      ? err({ code: 'stripe.malformed-answer', transient: true })
      : ok(body);
  }
}

/** The gateway of a deployment without provider credentials: it sends nothing. */
export class DisabledPayoutGateway implements PayoutGateway {
  readonly enabled = false;

  private refuse() {
    return Promise.resolve(err({ code: 'provider.not-configured', transient: true }));
  }

  createAccount() {
    return this.refuse();
  }

  createOnboardingLink() {
    return this.refuse();
  }

  createTransfer() {
    return this.refuse();
  }
}
