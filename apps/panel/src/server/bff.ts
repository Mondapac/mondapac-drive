// The panel server's relay to the API (marketplace ADR-0034 decision 3). Pure functions over `Request` and
// `Response`, so they are tested without a server. The relay forwards an allowlist of paths and
// headers, sets `x-market-id` from the request host, and refuses an unsafe request that is not
// same-origin, because the API's own origin check is fail-open when the headers are absent.

import 'server-only';
import {
  CLIENT_ADDRESS_HEADER,
  MissingClientAddressError,
  signForRequest,
} from '@mondapac-drive/panel-server/signer';
import type { PanelConfig, PanelHost } from './config.ts';

/** The paths this panel may reach, by method (its own population's routes). */
const ALLOWED: Readonly<Record<string, ReadonlySet<string>>> = {
  GET: new Set([
    'identity/admin/session',
    // Drive live map: couriers near a point, once and as a server-sent event stream.
    'tracking/admin/couriers/nearest',
    'tracking/admin/map/stream',
  ]),
  PUT: new Set([
    // The signed-in admin's own display name (profile).
    'identity/admin/profile/display-name',
    // The signed-in admin's own time zone and language (profile).
    'identity/admin/profile/preferences',
  ]),
  DELETE: new Set([]),
  POST: new Set([
    // The signed-in admin's other sessions are ended; this one stays (profile).
    'identity/admin/profile/sessions/sign-out-others',
    'identity/admin/sign-in',
    'identity/admin/second-factor',
    'identity/admin/sign-out',
    'identity/admin/invitations',
    'identity/admin/password-reset-email',
    'identity/admin/reset-password',
    // The signed-in admin's own password; the body carries a code from the app.
    'identity/admin/change-password',
    'identity/admin/invitation/enrolment',
    'identity/admin/invitation/accept',
    'identity/admin/roles',
    // Drive: a new merchant (operators) and a courier invitation (dispatchers).
    'identity/admin/merchants',
    'identity/admin/couriers/invitations',
  ]),
};

/**
 * Paths with resource ids (`:id`, a UUID), by method. Still exact: each segment must match
 * the template, and each id must be a UUID, so no other path shape reaches the API.
 */
const ALLOWED_WITH_ID: Readonly<Record<string, readonly string[]>> = {
  POST: [
    'identity/admin/accounts/:id/disable',
    'identity/admin/accounts/:id/enable',
    'identity/admin/accounts/:id/role',
    'identity/admin/accounts/:id/second-factor/reset',
    'identity/admin/invitations/:id/resend',
    'identity/admin/invitations/:id/revoke',
    // Drive: merchants and their API keys (the issue answer carries the key once).
    'identity/admin/merchants/:id/suspend',
    'identity/admin/merchants/:id/reinstate',
    'identity/admin/merchants/:id/api-keys',
    'identity/admin/merchants/:id/api-keys/:id/revoke',
    // Drive: couriers and deliveries.
    'identity/admin/couriers/:id/disable',
    'identity/admin/couriers/:id/enable',
    'delivery/admin/deliveries/:id/dispatch',
    'delivery/admin/deliveries/:id/cancel',
    // Drive payouts: a balance adjustment (idempotency key in the body) and the settle tool.
    'payouts/admin/couriers/:id/adjustments',
    'payouts/admin/lines/:id/settle',
  ],
  PUT: ['identity/admin/roles/:id'],
  DELETE: ['identity/admin/roles/:id'],
  GET: [
    // Drive live map: a delivery's breadcrumb trail.
    'tracking/admin/deliveries/:id/trail',
  ],
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/**
 * The only GET paths whose query string crosses to the API, and the keys that may cross. The
 * panel's lists are read by its page server; the live map asks for couriers near a point.
 */
const NEAR_POINT = ['lat', 'lng', 'radiusM', 'limit'] as const;
const QUERY_KEYS: Readonly<Record<string, readonly string[]>> = {
  'tracking/admin/couriers/nearest': NEAR_POINT,
  'tracking/admin/map/stream': NEAR_POINT,
};
/** The live map rounds a point to 4 decimals (about 11 m); a radius and a limit are whole numbers. */
const NEAR_POINT_SHAPES: Readonly<Record<string, RegExp>> = {
  lat: /^-?\d{1,2}(\.\d{1,4})?$/,
  lng: /^-?\d{1,3}(\.\d{1,4})?$/,
  radiusM: /^\d{1,6}$/,
  limit: /^\d{1,3}$/,
};
/** Query values that must have a shape to cross; a value of another shape is dropped. */
const QUERY_SHAPES: Readonly<Record<string, Readonly<Record<string, RegExp>>>> = {
  'tracking/admin/couriers/nearest': NEAR_POINT_SHAPES,
  'tracking/admin/map/stream': NEAR_POINT_SHAPES,
};
/** GET templates with a resource id whose query crosses, and the keys that may cross. */
const QUERY_KEYS_WITH_ID: Readonly<Record<string, readonly string[]>> = {};
const QUERY_VALUE_MAX = 512;

/** The allowed keys of the request's query, capped in length; everything else is dropped. */
function upstreamQuery(method: string, target: string, requestUrl: string): string {
  // The relay allows an id segment only when it is a UUID, so the template is the path with
  // each UUID segment named `:id`.
  const template = target
    .split('/')
    .map((part) => (UUID.test(part) ? ':id' : part))
    .join('/');
  const keys = method === 'GET' ? (QUERY_KEYS[target] ?? QUERY_KEYS_WITH_ID[template]) : undefined;
  if (keys === undefined) return '';
  const source = new URL(requestUrl).searchParams;
  const shapes = QUERY_SHAPES[target];
  const kept = new URLSearchParams();
  for (const key of keys) {
    const value = source.get(key);
    if (value === null || value.length > QUERY_VALUE_MAX) continue;
    if (shapes?.[key]?.test(value) !== false) kept.set(key, value);
  }
  const text = kept.toString();
  return text === '' ? '' : `?${text}`;
}

function isAllowed(method: string, path: readonly string[]): boolean {
  if (ALLOWED[method]?.has(path.join('/')) === true) return true;
  return (ALLOWED_WITH_ID[method] ?? []).some((template) => {
    const parts = template.split('/');
    return (
      parts.length === path.length &&
      parts.every((part, index) =>
        part === ':id' ? UUID.test(path[index] ?? '') : part === path[index],
      )
    );
  });
}

/** Request headers that cross to the API. Everything else is dropped. */
const FORWARDED_REQUEST_HEADERS = [
  'cookie',
  'content-type',
  'accept',
  'origin',
  'sec-fetch-site',
  'x-csrf-token',
  // The API keeps only a coarse browser and system code of it on a new session (profile).
  'user-agent',
] as const;

/** Response headers that cross back to the browser (Set-Cookie is handled on its own). */
const FORWARDED_RESPONSE_HEADERS = ['content-type', 'retry-after'] as const;

/** The API issues the correlation id and returns it in this header (ADR-0034 decision 3). */
const CORRELATION_HEADER = 'x-correlation-id';

/** One structured line per failed relay: ids and codes only, never a body, cookie or token. */
export type RelayLog = (line: Record<string, string | number>) => void;
const stdoutLog: RelayLog = (line) => console.log(JSON.stringify(line));

const MAX_BODY_BYTES = 16 * 1024;

/** A server-sent event stream crosses as a stream: the relay never buffers it. */
const EVENT_STREAM = /^text\/event-stream\b/i;

/** Lower case, no trailing dot on the host name; the port stays. */
export function normaliseHost(raw: string | null): string | null {
  if (raw === null) return null;
  const host = raw.trim().toLowerCase();
  if (host === '') return null;
  return host.replace(/\.(?=$|:)/, '');
}

export function panelHostFor(config: PanelConfig, rawHost: string | null): PanelHost | undefined {
  const host = normaliseHost(rawHost);
  return host === null ? undefined : config.hosts.find((entry) => entry.host === host);
}

const jsonError = (status: number, code: string): Response =>
  new Response(JSON.stringify({ statusCode: status, code }), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });

const notFound = (): Response =>
  new Response(null, { status: 404, headers: { 'cache-control': 'no-store' } });

/**
 * Headers for a request to the API: the allowlist plus the Market of the host, and, when this
 * panel has a signing key, the signed client address (ADR-0037). The browser's own
 * `x-client-address` is never forwarded; the signer reads only `x-drive-client-address`, which
 * `server.mjs` sets, and throws `MissingClientAddressError` when it is absent.
 */
export function upstreamHeaders(
  request: Request,
  host: PanelHost,
  config: PanelConfig,
  nowMilliseconds: () => number = Date.now,
): Headers {
  const headers = new Headers();
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  headers.set('x-market-id', host.marketId);
  if (config.clientAddressKey !== null) {
    headers.set(
      CLIENT_ADDRESS_HEADER,
      signForRequest({
        key: config.clientAddressKey,
        marketId: host.marketId,
        headers: request.headers,
        nowSeconds: Math.floor(nowMilliseconds() / 1000),
      }),
    );
  }
  return headers;
}

/** The request body as text, or null once more than `limit` bytes have arrived. */
async function readCapped(request: Request, limit: number): Promise<string | null> {
  if (request.body === null) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const decoder = new TextDecoder();
  return chunks.map((chunk) => decoder.decode(chunk, { stream: true })).join('') + decoder.decode();
}

/**
 * Relays one browser request to the API. `fetchImpl` is injected for tests; the route handler
 * passes the global `fetch`.
 */
export async function relay(
  config: PanelConfig,
  request: Request,
  path: readonly string[],
  fetchImpl: typeof fetch = fetch,
  log: RelayLog = stdoutLog,
): Promise<Response> {
  const host = panelHostFor(config, request.headers.get('host'));
  if (host === undefined) return notFound();
  const target = path.join('/');
  if (!isAllowed(request.method, path)) return notFound();
  if (request.headers.has('authorization')) return jsonError(401, 'session.invalid');
  if (request.method !== 'GET') {
    // Unsafe method: same-origin only, whatever the API would do with a missing header.
    if (request.headers.get('sec-fetch-site') !== 'same-origin')
      return jsonError(403, 'request.csrf');
    if (request.headers.get('origin') !== host.origin) return jsonError(403, 'request.csrf');
  }
  const declared = Number(request.headers.get('content-length') ?? 0);
  if (declared > MAX_BODY_BYTES) return jsonError(413, 'request.too-large');
  let body: string | undefined;
  if (request.method !== 'GET') {
    // Read the stream with a hard cap, so a chunked body without Content-Length is refused too.
    const read = await readCapped(request, MAX_BODY_BYTES);
    if (read === null) return jsonError(413, 'request.too-large');
    body = read;
  }
  let outgoing: Headers;
  try {
    outgoing = upstreamHeaders(request, host, config);
  } catch (error) {
    if (!(error instanceof MissingClientAddressError)) throw error;
    log({ msg: 'panel.relay.client-address-missing', method: request.method, path: target });
    return jsonError(503, 'access.unavailable');
  }
  let upstream: Response;
  try {
    upstream = await fetchImpl(
      `${config.apiBaseUrl}/${target}${upstreamQuery(request.method, target, request.url)}`,
      {
        method: request.method,
        headers: outgoing,
        ...(body === undefined ? {} : { body }),
        redirect: 'manual',
        cache: 'no-store',
        // The browser leaving ends the API request too, so a map stream frees its slot.
        signal: request.signal,
      },
    );
  } catch {
    log({
      msg: 'panel.relay.upstream-unreachable',
      method: request.method,
      path: target,
      marketId: host.marketId,
    });
    return jsonError(503, 'access.unavailable');
  }
  if (upstream.status >= 400) {
    log({
      msg: 'panel.relay.error-answer',
      method: request.method,
      path: target,
      status: upstream.status,
      marketId: host.marketId,
      correlationId: upstream.headers.get(CORRELATION_HEADER) ?? '',
    });
  }
  const headers = new Headers();
  for (const name of FORWARDED_RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  // Session answers must never be cached; the API sets no-store itself, this is the default.
  headers.set('cache-control', upstream.headers.get('cache-control') ?? 'private, no-store');
  for (const cookie of upstream.headers.getSetCookie()) headers.append('set-cookie', cookie);
  if (upstream.ok && EVENT_STREAM.test(upstream.headers.get('content-type') ?? '')) {
    headers.set('cache-control', 'no-store, no-transform');
    headers.set('x-accel-buffering', 'no');
    return new Response(upstream.body, { status: upstream.status, headers });
  }
  return new Response(upstream.status === 204 ? null : await upstream.arrayBuffer(), {
    status: upstream.status,
    headers,
  });
}
