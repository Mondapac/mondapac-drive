import { err, money, ok, Temporal, type Result } from '@mondapac-drive/shared-kernel';
import type { ProviderSecret } from '../../../platform/config/payment-provider';
import type { GatewayRefusal, PayoutGateway, ProviderTransfer } from '../application/ports';

/** One HTTPS call to the provider, and its answer. A GET has no body. */
export interface HttpRequest {
  readonly method: 'POST' | 'GET';
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
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
    ...(request.body === undefined ? {} : { body: request.body }),
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
const LINE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Transfers per page of a list, Stripe's maximum, and the pages one lookup reads at most. */
const PAGE_SIZE = 100;
export const MAX_TRANSFER_PAGES = 20;

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

/**
 * A refusal from Stripe's answer: its error code or type, never its message (it may echo input).
 * An idempotency error is transient: an earlier request under the same key exists and may have
 * been applied, so it must never read as "not paid".
 */
function refusalOf(response: HttpResponse): GatewayRefusal {
  const error = parseJson(response.body)?.error as Record<string, unknown> | undefined;
  const raw = typeof error?.code === 'string' ? error.code : error?.type;
  const code = typeof raw === 'string' && /^[a-z0-9_]{1,48}$/.test(raw) ? raw : 'unknown';
  const transient =
    response.status === 429 ||
    response.status >= 500 ||
    response.status === 409 ||
    code === 'idempotency_error';
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

  /**
   * Every transfer of one transfer group, page by page (newest first, as Stripe lists them). A
   * transfer whose answer is malformed fails the lookup: settling must see every transfer.
   */
  async transfersOfGroup(
    group: string,
  ): Promise<Result<readonly ProviderTransfer[], GatewayRefusal>> {
    const found: ProviderTransfer[] = [];
    let after: string | undefined;
    for (let page = 0; page < MAX_TRANSFER_PAGES; page += 1) {
      const query = new URLSearchParams({ transfer_group: group, limit: String(PAGE_SIZE) });
      if (after !== undefined) query.set('starting_after', after);
      const answer = await this.send('GET', `/transfers?${query.toString()}`);
      if (!answer.ok) return answer;
      const { data, has_more: hasMore } = answer.value;
      if (!Array.isArray(data) || typeof hasMore !== 'boolean') {
        return err({ code: 'stripe.malformed-answer', transient: true });
      }
      for (const item of data as unknown[]) {
        const transfer = transferOf(item);
        if (transfer === undefined)
          return err({ code: 'stripe.malformed-answer', transient: true });
        found.push(transfer);
      }
      const last = found.at(-1);
      if (!hasMore) return ok(found);
      if (last === undefined) return err({ code: 'stripe.malformed-answer', transient: true });
      after = last.transferId;
    }
    return err({ code: 'stripe.too-many-transfers', transient: false });
  }

  private post(
    path: string,
    fields: FormFields,
    idempotencyKey?: string,
  ): Promise<Result<Record<string, unknown>, GatewayRefusal>> {
    return this.send('POST', path, form(fields), idempotencyKey);
  }

  private async send(
    method: 'POST' | 'GET',
    path: string,
    body?: string,
    idempotencyKey?: string,
  ): Promise<Result<Record<string, unknown>, GatewayRefusal>> {
    let response: HttpResponse;
    try {
      response = await this.transport({
        method,
        url: `${API}${path}`,
        headers: {
          authorization: `Bearer ${this.secretKey.reveal()}`,
          ...(body === undefined ? {} : { 'content-type': 'application/x-www-form-urlencoded' }),
          ...(idempotencyKey === undefined ? {} : { 'idempotency-key': idempotencyKey }),
        },
        ...(body === undefined ? {} : { body }),
      });
    } catch {
      // A timeout or a lost connection: the request may have been applied, so it is retried
      // with the same idempotency key.
      return err({ code: 'stripe.unreachable', transient: true });
    }
    if (response.status < 200 || response.status >= 300) return err(refusalOf(response));
    const answer = parseJson(response.body);
    return answer === undefined
      ? err({ code: 'stripe.malformed-answer', transient: true })
      : ok(answer);
  }
}

/** One listed transfer, or `undefined` when it is not shaped as Stripe documents it. */
function transferOf(item: unknown): ProviderTransfer | undefined {
  if (typeof item !== 'object' || item === null) return undefined;
  const { id, amount, currency, destination, metadata } = item as Record<string, unknown>;
  if (
    typeof id !== 'string' ||
    !ID.test(id) ||
    typeof amount !== 'number' ||
    !Number.isSafeInteger(amount) ||
    amount < 0 ||
    typeof currency !== 'string' ||
    !/^[a-z]{3}$/.test(currency) ||
    typeof destination !== 'string' ||
    !ID.test(destination)
  ) {
    return undefined;
  }
  const lineId =
    typeof metadata === 'object' && metadata !== null
      ? (metadata as Record<string, unknown>).payoutLineId
      : undefined;
  return {
    transferId: id,
    amount: money(BigInt(amount), currency.toUpperCase()),
    destination,
    ...(typeof lineId === 'string' && LINE_ID.test(lineId) ? { payoutLineId: lineId } : {}),
  };
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

  transfersOfGroup() {
    return this.refuse();
  }
}
