import { createHmac } from 'node:crypto';
import { isIPv4, isIPv6 } from 'node:net';
import { inspect } from 'node:util';
import { expandIPv6 } from '../rate-limit/client-origin';

/**
 * The deployment settings of ADR-0037 (decisions 4 and 5): which networks the BFF servers send
 * from, and the HMAC keys each of them signs `x-client-address` with. Parsed once at start-up
 * from `TRUSTED_BFF_CIDRS` and `CLIENT_ADDRESS_KEYS`; any problem refuses the start. A problem
 * names an entry by its keyId or position, never a secret.
 */

/** The narrowest network a CIDR may name is any; the widest is /16 (IPv4) or /48 (IPv6). */
export const MIN_PREFIX = { 4: 16, 6: 48 } as const;
/** The shortest secret: 32 bytes (ADR-0037 decision 4). */
export const MIN_SECRET_BYTES = 32;
/** A keyId: lower-case letters, digits and hyphens, 1 to 32 characters. */
export const KEY_ID_PATTERN = /^[a-z0-9-]{1,32}$/;

/** An IP address as a number of its family. */
export interface IpAddress {
  readonly family: 4 | 6;
  readonly value: bigint;
}

/** A network: the address with its host bits clear, and the prefix length. */
export interface Cidr {
  readonly family: 4 | 6;
  readonly network: bigint;
  readonly prefix: number;
  /** The CIDR as configured; not secret, safe in a start-up message. */
  readonly text: string;
}

/**
 * An HMAC secret. Its bytes never leave this object: it is printed, inspected and serialised as
 * a fixed marker, so a configuration object that reaches a log carries no key (ADR-0037 d7).
 */
export class ClientAddressSecret {
  readonly #bytes: Buffer;

  constructor(bytes: Buffer) {
    this.#bytes = Buffer.from(bytes);
  }

  /** HMAC-SHA-256 of `message` (UTF-8) under this secret. */
  sign(message: string): Buffer {
    return createHmac('sha256', this.#bytes).update(message, 'utf8').digest();
  }

  /** True when both secrets hold the same bytes (start-up check only, not constant time). */
  sameAs(other: ClientAddressSecret): boolean {
    return this.#bytes.equals(other.#bytes);
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

/** One `CLIENT_ADDRESS_KEYS` entry: a keyId, the networks it is valid from, its secret. */
export interface ClientAddressKey {
  readonly keyId: string;
  readonly cidrs: readonly Cidr[];
  readonly secret: ClientAddressSecret;
}

/** The feature's settings; `null` in `AppConfig` when both variables are empty (off). */
export interface ClientAddressTrust {
  /** `TRUSTED_BFF_CIDRS`: every network a BFF may send from. */
  readonly bffCidrs: readonly Cidr[];
  /** `CLIENT_ADDRESS_KEYS` by keyId. */
  readonly keys: ReadonlyMap<string, ClientAddressKey>;
}

/** An IPv4 or IPv6 address as a number; null for anything else (a zone index included). */
export function parseIpAddress(text: string): IpAddress | null {
  if (isIPv4(text)) {
    const value = text
      .split('.')
      .reduce((sum, part) => (sum << 8n) | BigInt(Number.parseInt(part, 10)), 0n);
    return { family: 4, value };
  }
  if (!isIPv6(text) || text.includes('%')) return null;
  const groups = expandIPv6(text);
  if (groups === null) return null;
  return { family: 6, value: groups.reduce((sum, group) => (sum << 16n) | BigInt(group), 0n) };
}

const BITS = { 4: 32, 6: 128 } as const;

/** True when `address` lies inside `cidr` (same family only). */
export function cidrContains(cidr: Cidr, address: IpAddress): boolean {
  if (cidr.family !== address.family) return false;
  const shift = BigInt(BITS[cidr.family] - cidr.prefix);
  return address.value >> shift === cidr.network >> shift;
}

/** True when every address of `inner` lies inside `outer`. */
function cidrWithin(inner: Cidr, outer: Cidr): boolean {
  return (
    inner.family === outer.family &&
    inner.prefix >= outer.prefix &&
    cidrContains(outer, { family: inner.family, value: inner.network })
  );
}

/**
 * Parses one CIDR, or answers why it is refused (decision 5). The reason never quotes the text:
 * the caller decides whether the text may be shown (never inside a key entry, Hassan L2).
 */
export function parseCidr(text: string): Cidr | string {
  const match = /^([^/\s]+)\/(\d{1,3})$/.exec(text);
  if (match === null) return 'is not a CIDR such as 10.20.1.0/24';
  const address = parseIpAddress(match[1]!);
  if (address === null) return 'is not a CIDR such as 10.20.1.0/24';
  const prefix = Number(match[2]);
  if (prefix > BITS[address.family]) return 'has a prefix longer than the address';
  if (prefix === 0) return 'trusts every address (0.0.0.0/0 and ::/0 are refused)';
  if (prefix < MIN_PREFIX[address.family]) {
    return `is wider than /${MIN_PREFIX[address.family]}`;
  }
  if (address.family === 6 && address.value >> 32n === 0xffffn) {
    return 'is an IPv4-mapped range; write the IPv4 CIDR';
  }
  const hostBits = BigInt(BITS[address.family] - prefix);
  if (address.value & ((1n << hostBits) - 1n)) return 'has host bits set';
  return { family: address.family, network: address.value, prefix, text };
}

const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** Empty or unset, after trimming. */
function isBlank(value: string | undefined): boolean {
  return value === undefined || value.trim().length === 0;
}

/**
 * Parses a comma-separated CIDR list. `quote` shows a refused CIDR's text; inside a
 * `CLIENT_ADDRESS_KEYS` entry it is false and a CIDR is named by its position only, because a
 * misordered entry would put the secret where a CIDR is expected (Hassan L2).
 */
function parseCidrList(text: string, label: string, issues: string[], quote: boolean): Cidr[] {
  const cidrs: Cidr[] = [];
  text
    .split(',')
    .map((entry) => entry.trim())
    .forEach((part, index) => {
      if (part.length === 0) {
        issues.push(`${label}: has an empty CIDR`);
        return;
      }
      const cidr = parseCidr(part);
      const name = quote ? `"${part}"` : `CIDR ${index + 1}`;
      if (typeof cidr === 'string') issues.push(`${label}: ${name} ${cidr}`);
      else cidrs.push(cidr);
    });
  return cidrs;
}

/**
 * Parses `TRUSTED_BFF_CIDRS` and `CLIENT_ADDRESS_KEYS` (ADR-0037 decisions 4 and 5). Both blank:
 * the feature is off (`trust: null`). Otherwise every problem is listed in `issues` and the
 * caller refuses to start.
 */
export function parseClientAddressTrust(
  cidrsText: string | undefined,
  keysText: string | undefined,
): { readonly trust: ClientAddressTrust | null; readonly issues: readonly string[] } {
  if (isBlank(cidrsText) && isBlank(keysText)) return { trust: null, issues: [] };
  const issues: string[] = [];
  if (isBlank(keysText)) {
    issues.push('TRUSTED_BFF_CIDRS: is set but CLIENT_ADDRESS_KEYS is empty; set both or neither');
  }
  if (isBlank(cidrsText)) {
    issues.push('CLIENT_ADDRESS_KEYS: is set but TRUSTED_BFF_CIDRS is empty; set both or neither');
  }
  if (issues.length > 0) return { trust: null, issues };

  const bffCidrs = parseCidrList(cidrsText!, 'TRUSTED_BFF_CIDRS', issues, true);
  const keys = new Map<string, ClientAddressKey>();
  const entries = keysText!.split(';').map((entry) => entry.trim());
  entries.forEach((entry, index) => {
    const position = `CLIENT_ADDRESS_KEYS entry ${index + 1}`;
    if (entry.length === 0) {
      issues.push(`${position}: is empty`);
      return;
    }
    const first = entry.indexOf(':');
    const last = entry.lastIndexOf(':');
    if (first <= 0 || last === first) {
      issues.push(`${position}: must be keyId:cidrs:base64`);
      return;
    }
    const keyId = entry.slice(0, first);
    if (!KEY_ID_PATTERN.test(keyId)) {
      issues.push(`${position}: the keyId must match [a-z0-9-]{1,32}`);
      return;
    }
    const label = `CLIENT_ADDRESS_KEYS key "${keyId}"`;
    const cidrsPart = entry.slice(first + 1, last).trim();
    const secretText = entry.slice(last + 1).trim();
    const cidrs = cidrsPart.length === 0 ? [] : parseCidrList(cidrsPart, label, issues, false);
    if (cidrsPart.length === 0) issues.push(`${label}: names no CIDR`);
    cidrs.forEach((cidr, position) => {
      if (!bffCidrs.some((outer) => cidrWithin(cidr, outer))) {
        issues.push(`${label}: CIDR ${position + 1} is not inside TRUSTED_BFF_CIDRS`);
      }
    });
    // The secret's text is never quoted in a message.
    if (secretText.length === 0 || !BASE64.test(secretText)) {
      issues.push(`${label}: the secret is not valid base64`);
      return;
    }
    const bytes = Buffer.from(secretText, 'base64');
    if (bytes.length < MIN_SECRET_BYTES) {
      issues.push(`${label}: the secret is shorter than ${MIN_SECRET_BYTES} bytes`);
      return;
    }
    const secret = new ClientAddressSecret(bytes);
    if (keys.has(keyId)) {
      issues.push(`${label}: the keyId is listed twice`);
      return;
    }
    const twin = [...keys.values()].find((other) => other.secret.sameAs(secret));
    if (twin !== undefined) {
      issues.push(`${label}: shares its secret with key "${twin.keyId}"; each keyId has its own`);
      return;
    }
    keys.set(keyId, Object.freeze({ keyId, cidrs: Object.freeze(cidrs), secret }));
  });

  if (issues.length > 0) return { trust: null, issues };
  return {
    trust: Object.freeze({ bffCidrs: Object.freeze(bffCidrs), keys }),
    issues: [],
  };
}
