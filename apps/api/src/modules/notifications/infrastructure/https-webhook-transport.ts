import { lookup as systemLookup, type LookupAddress } from 'node:dns';
import { request } from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import type { WebhookResponse, WebhookTransport } from '../application/ports';
import { isPublicAddress, type WebhookUrl } from '../domain/webhook-url';

/** The longest one webhook attempt may take, connection and answer included. */
export const WEBHOOK_TIMEOUT_MS = 10_000;
/** The most of an answer's body that is read; the rest is discarded unread. */
const MAX_RESPONSE_BYTES = 4096;

/** Resolves a host name to every address it has. */
export type Resolver = (hostname: string) => Promise<LookupAddress[]>;

export const systemResolver: Resolver = (hostname) =>
  new Promise((resolve, reject) =>
    systemLookup(hostname, { all: true, verbatim: true }, (error, addresses) =>
      error ? reject(error) : resolve(addresses),
    ),
  );

/** A webhook host resolved to an address that is not on the public Internet. */
export class PrivateAddressError extends Error {
  override readonly name = 'PrivateAddressError';
  readonly code = 'webhook-url.private-host';
  constructor() {
    super('The webhook host resolves to an address that is not public');
  }
}

/**
 * The socket's DNS lookup for webhook calls (SSRF control): the connection goes only to an
 * address checked here, so a name that resolves inside the network, or is re-pointed there
 * after the subscription was made (DNS rebinding), is refused. Every address must be public,
 * not only the one picked.
 */
export function guardedLookup(resolve: Resolver): LookupFunction {
  return (hostname, options, callback) => {
    resolve(hostname).then(
      (addresses) => {
        if (addresses.length === 0 || !addresses.every((entry) => isPublicAddress(entry.address))) {
          callback(new PrivateAddressError(), '', 4);
          return;
        }
        if (options.all === true) {
          (callback as unknown as (error: null, addresses: LookupAddress[]) => void)(
            null,
            addresses,
          );
          return;
        }
        const first = addresses[0]!;
        callback(null, first.address, first.family);
      },
      (error: NodeJS.ErrnoException) => callback(error, '', 4),
    );
  };
}

/**
 * Posts webhooks over HTTPS with Node's client: certificate checked, no redirect followed, no
 * proxy, a new connection each time, {@link WEBHOOK_TIMEOUT_MS} for the whole attempt. 2xx is
 * success; 410 Gone stops retrying; every other answer and network failure is retried.
 */
export class HttpsWebhookTransport implements WebhookTransport {
  constructor(private readonly resolve: Resolver = systemResolver) {}

  post(
    url: WebhookUrl,
    headers: Readonly<Record<string, string>>,
    body: string,
  ): Promise<WebhookResponse> {
    const target = new URL(url);
    const host = target.hostname.replace(/^\[|\]$/g, '');
    // A literal address skips the lookup, so it is checked here.
    if (isIP(host) !== 0 && !isPublicAddress(host)) {
      return Promise.resolve(failure('webhook-url.private-host', null, false));
    }
    const payload = Buffer.from(body, 'utf8');
    return new Promise<WebhookResponse>((settle) => {
      const outgoing = request(
        target,
        {
          method: 'POST',
          agent: false,
          lookup: guardedLookup(this.resolve),
          signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
          headers: {
            ...headers,
            'Content-Length': String(payload.length),
            'User-Agent': 'MondapacDrive-Webhooks/1',
          },
        },
        (response) => {
          let read = 0;
          response.on('data', (chunk: Buffer) => {
            read += chunk.length;
            if (read > MAX_RESPONSE_BYTES) response.destroy();
          });
          const done = () => {
            const status = response.statusCode ?? 0;
            settle(
              status >= 200 && status < 300
                ? { ok: true, statusCode: status }
                : failure(`http.${status}`, status, status !== 410),
            );
          };
          response.on('end', done);
          response.on('close', done);
          response.on('error', done);
        },
      );
      outgoing.on('error', (error: Error & { code?: string }) => {
        if (error instanceof PrivateAddressError) {
          settle(failure(error.code, null, false));
        } else if (error.name === 'AbortError' || error.name === 'TimeoutError') {
          settle(failure('webhook.timeout', null, true));
        } else if (typeof error.code === 'string' && error.code.startsWith('ERR_TLS')) {
          settle(failure('webhook.tls', null, true));
        } else {
          settle(failure('webhook.network', null, true));
        }
      });
      outgoing.end(payload);
    });
  }
}

function failure(errorCode: string, statusCode: number | null, retryable: boolean) {
  return { ok: false as const, errorCode, statusCode, retryable };
}
