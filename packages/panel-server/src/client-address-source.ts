// The request-side half of ADR-0037 decision 9: before Next.js sees a request, the panel's own
// `server.mjs` removes every client-address header a browser could have sent and sets one
// internal header, `x-drive-client-address`, from the socket peer or (behind a trusted edge) from
// the single header the edge is configured to set. The signer reads only the internal header.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isIP } from 'node:net';
import { cidrContains, normalisePeer, parseCidrList, parseAddress, type Cidr } from './cidr.ts';

export const INTERNAL_ADDRESS_HEADER = 'x-drive-client-address';

/** Removed from every request, whatever the case and however often repeated. */
const SCRUBBED = [
  'x-forwarded-for',
  'forwarded',
  'x-real-ip',
  'x-client-address',
  INTERNAL_ADDRESS_HEADER,
] as const;

/** Names the edge header may not take: they carry meaning elsewhere. */
const RESERVED_EDGE_HEADERS = new Set<string>([...SCRUBBED, 'x-market-id']);

const HEADER_TOKEN = /^[a-z0-9][a-z0-9-]*$/;

export type ClientAddressSource =
  | { readonly mode: 'socket' }
  | { readonly mode: 'edge'; readonly cidrs: readonly Cidr[]; readonly header: string };

type Env = Readonly<Record<string, string | undefined>>;

/** Reads the three variables; any inconsistency throws, so start-up fails (no default). */
export function parseClientAddressSource(env: Env): ClientAddressSource {
  const mode = env['CLIENT_ADDRESS_SOURCE']?.trim();
  const cidrText = env['EDGE_CIDRS']?.trim() ?? '';
  const header = env['EDGE_CLIENT_ADDRESS_HEADER']?.trim() ?? '';
  if (mode === 'socket') {
    if (cidrText !== '' || header !== '') {
      throw new Error(
        'CLIENT_ADDRESS_SOURCE=socket must not set EDGE_CIDRS or EDGE_CLIENT_ADDRESS_HEADER',
      );
    }
    return { mode: 'socket' };
  }
  if (mode !== 'edge') {
    throw new Error('CLIENT_ADDRESS_SOURCE is required and must be "socket" or "edge"');
  }
  if (cidrText === '' || header === '') {
    throw new Error(
      'CLIENT_ADDRESS_SOURCE=edge requires EDGE_CIDRS and EDGE_CLIENT_ADDRESS_HEADER',
    );
  }
  if (!HEADER_TOKEN.test(header)) {
    throw new Error('EDGE_CLIENT_ADDRESS_HEADER must be a lowercase header name');
  }
  if (RESERVED_EDGE_HEADERS.has(header)) {
    throw new Error(`EDGE_CLIENT_ADDRESS_HEADER cannot be ${header}`);
  }
  return { mode: 'edge', cidrs: parseCidrList(cidrText), header };
}

export type RefusalReason =
  'peer-unknown' | 'edge-header-missing' | 'edge-header-repeated' | 'edge-header-invalid';

type Resolution =
  | { readonly ok: true; readonly address: string }
  | { readonly ok: false; readonly reason: RefusalReason };

/** Removes the scrubbed headers (and the edge one) from `headers` and `rawHeaders`, in place. */
function scrub(request: IncomingMessage, extra: readonly string[]): void {
  const names = new Set<string>([...SCRUBBED, ...extra]);
  // Node builds `headers` and `headersDistinct` lazily from `rawHeaders` and the header count it
  // saved at parse time. Build both before `rawHeaders` shrinks, or `headersDistinct` throws.
  const distinct = request.headersDistinct;
  for (const name of names) {
    delete request.headers[name];
    delete distinct[name];
  }
  const kept: string[] = [];
  for (let index = 0; index + 1 < request.rawHeaders.length; index += 2) {
    const name = request.rawHeaders[index] ?? '';
    if (!names.has(name.toLowerCase())) kept.push(name, request.rawHeaders[index + 1] ?? '');
  }
  request.rawHeaders.length = 0;
  request.rawHeaders.push(...kept);
}

function edgeValues(request: IncomingMessage, header: string): string[] {
  const values: string[] = [];
  for (let index = 0; index + 1 < request.rawHeaders.length; index += 2) {
    if ((request.rawHeaders[index] ?? '').toLowerCase() === header) {
      values.push(request.rawHeaders[index + 1] ?? '');
    }
  }
  return values;
}

function resolve(request: IncomingMessage, source: ClientAddressSource): Resolution {
  const remote = request.socket.remoteAddress;
  if (remote === undefined || parseAddress(normalisePeer(remote)) === null) {
    return { ok: false, reason: 'peer-unknown' };
  }
  const peer = normalisePeer(remote);
  if (source.mode === 'socket' || !source.cidrs.some((cidr) => cidrContains(cidr, peer))) {
    return { ok: true, address: peer };
  }
  const values = edgeValues(request, source.header);
  if (values.length === 0) return { ok: false, reason: 'edge-header-missing' };
  if (values.length > 1) return { ok: false, reason: 'edge-header-repeated' };
  const value = (values[0] ?? '').trim();
  if (value === '' || isIP(value) === 0 || parseAddress(value) === null) {
    return { ok: false, reason: 'edge-header-invalid' };
  }
  return { ok: true, address: value };
}

/**
 * Cleans the request and sets `x-drive-client-address`. Returns false when the request came from an
 * edge peer without exactly one valid address (the caller answers 400, no fallback), with the
 * reason in `refusal`; the header value is never part of it.
 */
export function applyClientAddress(
  request: IncomingMessage,
  source: ClientAddressSource,
  onRefusal?: (reason: RefusalReason, peer: string) => void,
): boolean {
  const resolution = resolve(request, source);
  scrub(request, source.mode === 'edge' ? [source.header] : []);
  if (!resolution.ok) {
    onRefusal?.(resolution.reason, request.socket.remoteAddress ?? '');
    return false;
  }
  request.headers[INTERNAL_ADDRESS_HEADER] = resolution.address;
  request.headersDistinct[INTERNAL_ADDRESS_HEADER] = [resolution.address];
  request.rawHeaders.push(INTERNAL_ADDRESS_HEADER, resolution.address);
  return true;
}

export function refuseUntrustedAddress(response: ServerResponse): void {
  const body = JSON.stringify({ statusCode: 400, code: 'client-address.untrusted' });
  response.writeHead(400, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    connection: 'close',
  });
  response.end(body);
}
