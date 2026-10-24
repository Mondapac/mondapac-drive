// CIDR parsing and matching for EDGE_CIDRS, with the rules of ADR-0037 decision 5: a prefix is
// required, no host bits, no IPv4-mapped IPv6 range, and nothing wider than /16 (IPv4) or /48 (IPv6).
import { isIP } from 'node:net';

export interface Cidr {
  readonly family: 4 | 6;
  readonly network: bigint;
  readonly prefix: number;
}

export interface ParsedAddress {
  readonly family: 4 | 6;
  readonly value: bigint;
}

const MAPPED_PREFIX = 0xffffn << 32n; // ::ffff:0:0/96 as the high bits of the 128-bit value

/** An IP address as a number, or null when it is not exactly one address (a zone index is refused). */
export function parseAddress(text: string): ParsedAddress | null {
  const family = isIP(text);
  if (family === 0 || text.includes('%')) return null;
  if (family === 4) return { family: 4, value: ipv4ToBigInt(text) };
  const value = ipv6ToBigInt(text);
  return value === null ? null : { family: 6, value };
}

function ipv4ToBigInt(text: string): bigint {
  return text.split('.').reduce((total, part) => (total << 8n) + BigInt(Number(part)), 0n);
}

function ipv6ToBigInt(text: string): bigint | null {
  let head = text.toLowerCase();
  let tail = 0n;
  let tailGroups = 0;
  const lastColon = head.lastIndexOf(':');
  if (head.slice(lastColon + 1).includes('.')) {
    const v4 = head.slice(lastColon + 1);
    if (isIP(v4) !== 4) return null;
    tail = ipv4ToBigInt(v4);
    tailGroups = 2;
    head = `${head.slice(0, lastColon + 1)}0:0`;
  }
  const halves = head.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] === '' ? [] : (halves[0] ?? '').split(':');
  const right = halves.length === 2 ? (halves[1] === '' ? [] : (halves[1] ?? '').split(':')) : [];
  const missing = 8 - left.length - right.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [...left, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...right];
  if (groups.length !== 8) return null;
  let value = 0n;
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
    value = (value << 16n) + BigInt(parseInt(group, 16));
  }
  if (tailGroups === 2) value = (value & ~0xffffffffn) | tail;
  return value;
}

/** `::ffff:203.0.113.7` is the IPv4 address 203.0.113.7; anything else is returned as it is. */
export function normalisePeer(address: string): string {
  const match = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address);
  return match?.[1] !== undefined && isIP(match[1]) === 4 ? match[1] : address;
}

export class CidrError extends Error {}

export function parseCidr(text: string): Cidr {
  const entry = text.trim();
  const slash = entry.indexOf('/');
  if (slash < 1 || entry.indexOf('/', slash + 1) !== -1) {
    throw new CidrError(`'${entry}' is not a CIDR with a prefix length`);
  }
  const address = parseAddress(entry.slice(0, slash));
  const prefixText = entry.slice(slash + 1);
  if (address === null || !/^\d{1,3}$/.test(prefixText)) {
    throw new CidrError(`'${entry}' is not a valid CIDR`);
  }
  const bits = address.family === 4 ? 32 : 128;
  const prefix = Number(prefixText);
  if (prefix > bits) throw new CidrError(`'${entry}' has a prefix longer than ${bits}`);
  const minimum = address.family === 4 ? 16 : 48;
  if (prefix < minimum) {
    const all =
      prefix === 0 ? ` (${address.family === 4 ? '0.0.0.0/0' : '::/0'} trusts everything)` : '';
    throw new CidrError(`'${entry}' is wider than /${minimum}${all}`);
  }
  const hostBits = BigInt(bits - prefix);
  if ((address.value & ((1n << hostBits) - 1n)) !== 0n) {
    throw new CidrError(`'${entry}' has host bits set`);
  }
  if (address.family === 6 && address.value >> 32n === MAPPED_PREFIX >> 32n) {
    throw new CidrError(`'${entry}' is an IPv4-mapped IPv6 range; write the IPv4 range instead`);
  }
  return { family: address.family, network: address.value, prefix };
}

export function parseCidrList(text: string): readonly Cidr[] {
  return text.split(',').map((entry) => parseCidr(entry));
}

export function cidrContains(cidr: Cidr, text: string): boolean {
  const address = parseAddress(normalisePeer(text));
  if (address === null || address.family !== cidr.family) return false;
  const bits = cidr.family === 4 ? 32 : 128;
  const shift = BigInt(bits - cidr.prefix);
  return address.value >> shift === cidr.network >> shift;
}
