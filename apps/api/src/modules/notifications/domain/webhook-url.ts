import { err, ok, type Result } from '@mondapac-drive/shared-kernel';

/**
 * Where a merchant's webhooks go (SSRF rules). The URL is HTTPS with a DNS name or a public IP,
 * no credentials and no fragment. Names that only resolve inside a network (`localhost`,
 * `.local`, `.internal`, `.home.arpa`, single labels) are refused here; every address a name
 * on port 443 or 8443. Every address a name
 * resolves to is checked again with {@link isPublicAddress} on each send, so a name that later
 * points inside is refused too.
 */
export type WebhookUrl = string & { readonly __brand: 'WebhookUrl' };

export type WebhookUrlError =
  | 'webhook-url.invalid'
  | 'webhook-url.not-https'
  | 'webhook-url.credentials'
  | 'webhook-url.port'
  | 'webhook-url.private-host';

export const MAX_WEBHOOK_URL_LENGTH = 2048;

/** The ports a webhook may use: HTTPS and its common alternative. */
const ALLOWED_PORTS = new Set(['', '443', '8443']);

const INTERNAL_SUFFIXES = ['.localhost', '.local', '.internal', '.home.arpa', '.lan', '.intranet'];

export function parseWebhookUrl(raw: string): Result<WebhookUrl, WebhookUrlError> {
  if (raw.length === 0 || raw.length > MAX_WEBHOOK_URL_LENGTH || raw.trim() !== raw) {
    return err('webhook-url.invalid');
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return err('webhook-url.invalid');
  }
  if (url.protocol !== 'https:') return err('webhook-url.not-https');
  if (url.username !== '' || url.password !== '') return err('webhook-url.credentials');
  if (url.hash !== '') return err('webhook-url.invalid');
  if (!ALLOWED_PORTS.has(url.port)) return err('webhook-url.port');
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (host.startsWith('[') || /^[0-9.]+$/.test(host)) {
    if (!isPublicAddress(host)) return err('webhook-url.private-host');
  } else if (
    host === 'localhost' ||
    !host.includes('.') ||
    INTERNAL_SUFFIXES.some((suffix) => host.endsWith(suffix))
  ) {
    return err('webhook-url.private-host');
  }
  return ok(url.toString() as WebhookUrl);
}

/** IPv4 ranges that are not on the public Internet (RFC 6890 and friends): [first octets, bits]. */
const PRIVATE_V4: readonly (readonly [readonly number[], number])[] = [
  [[0], 8], // "this" network
  [[10], 8], // private
  [[100, 64], 10], // carrier-grade NAT
  [[127], 8], // loopback
  [[169, 254], 16], // link-local, cloud metadata
  [[172, 16], 12], // private
  [[192, 0, 0], 24], // IETF protocol assignments
  [[192, 0, 2], 24], // documentation
  [[192, 88, 99], 24], // 6to4 relay
  [[192, 168], 16], // private
  [[198, 18], 15], // benchmarking
  [[198, 51, 100], 24], // documentation
  [[203, 0, 113], 24], // documentation
  [[224], 4], // multicast
  [[240], 4], // reserved and broadcast
];

function inV4Range(octets: readonly number[], prefix: readonly number[], bits: number): boolean {
  const value = octets.reduce((sum, octet) => sum * 256 + octet, 0);
  const base = [...prefix, 0, 0, 0, 0].slice(0, 4).reduce((sum, octet) => sum * 256 + octet, 0);
  const size = 2 ** (32 - bits);
  return Math.floor(value / size) === Math.floor(base / size);
}

function isPublicV4(octets: readonly number[]): boolean {
  return !PRIVATE_V4.some(([prefix, bits]) => inV4Range(octets, prefix, bits));
}

function parseV4(text: string): number[] | undefined {
  const parts = text.split('.');
  if (parts.length !== 4) return undefined;
  const octets = parts.map((part) => (/^(0|[1-9][0-9]{0,2})$/.test(part) ? Number(part) : NaN));
  return octets.every((octet) => octet >= 0 && octet <= 255) ? octets : undefined;
}

function parseV6(text: string): number[] | undefined {
  let rest = text;
  const tail: number[] = [];
  if (rest.includes('.')) {
    // A trailing dotted IPv4 (`::ffff:192.0.2.1`) holds the last two words.
    const lastColon = rest.lastIndexOf(':');
    const v4 = parseV4(rest.slice(lastColon + 1));
    if (v4 === undefined) return undefined;
    tail.push((v4[0]! << 8) | v4[1]!, (v4[2]! << 8) | v4[3]!);
    rest = rest.slice(0, lastColon + 1);
    if (!rest.endsWith('::')) rest = rest.slice(0, -1);
  }
  const halves = rest.split('::');
  if (halves.length > 2) return undefined;
  const group = (part: string) => (part === '' ? [] : part.split(':'));
  const head = group(halves[0] ?? '');
  const after = halves.length === 2 ? group(halves[1] ?? '') : [];
  const words = [...head, ...after].map((word) =>
    /^[0-9a-f]{1,4}$/i.test(word) ? parseInt(word, 16) : NaN,
  );
  if (words.some(Number.isNaN)) return undefined;
  const total = words.length + tail.length;
  if (halves.length === 1 && total !== 8) return undefined;
  if (halves.length === 2 && total > 7) return undefined;
  const zeros = new Array<number>(8 - total).fill(0);
  return [
    ...words.slice(0, head.length),
    ...(halves.length === 2 ? zeros : []),
    ...words.slice(head.length),
    ...tail,
  ];
}

/**
 * Whether an address resolved for a webhook host is on the public Internet. IPv4 outside the
 * private, loopback, link-local, shared, documentation, multicast and reserved ranges; IPv6
 * only in global unicast (2000::/3), outside documentation and the IETF block, with the IPv4
 * inside a mapped, NAT64 or 6to4 address checked as IPv4. Anything unparsable is not public.
 */
export function isPublicAddress(address: string): boolean {
  const bare = address.replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  const v4 = parseV4(bare);
  if (v4 !== undefined) return isPublicV4(v4);
  const v6 = bare.includes(':') ? parseV6(bare.toLowerCase()) : undefined;
  if (v6 === undefined) return false;
  const embedded = (high: number, low: number) => [high >> 8, high & 255, low >> 8, low & 255];
  const zeroPrefix = v6.slice(0, 5).every((word) => word === 0);
  if (zeroPrefix && v6[5] === 0xffff) return isPublicV4(embedded(v6[6]!, v6[7]!));
  if (v6[0] === 0x64 && v6[1] === 0xff9b && v6.slice(2, 6).every((word) => word === 0)) {
    return isPublicV4(embedded(v6[6]!, v6[7]!));
  }
  if (v6[0] === 0x2002) return isPublicV4(embedded(v6[1]!, v6[2]!));
  if ((v6[0]! & 0xe000) !== 0x2000) return false;
  if (v6[0] === 0x2001 && (v6[1] === 0x0db8 || v6[1]! < 0x0200)) return false;
  return true;
}
