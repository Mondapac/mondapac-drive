import { isIPv4, isIPv6 } from 'node:net';

/**
 * The origin a per-origin counter is kept for (identity design 6.8, HF3): the IPv4 address, or
 * the IPv6 /64, so rotating through one network's addresses does not multiply the limit.
 *
 * Its input is the client address resolved once per request by `platform/http/client-address.ts`
 * (`clientAddressFrom`): the socket's address, or the address a BFF proved (ADR-0037).
 * `X-Forwarded-For`, `Forwarded` and `X-Real-IP` are never read; `configureApp` sets `trust
 * proxy` to false. Answers `null` when there is no usable address, which the caller treats as
 * "cannot be evaluated" (fail closed).
 */
export function clientOriginOf(clientAddress: string | undefined): string | null {
  if (typeof clientAddress !== 'string' || clientAddress.length === 0) return null;
  // A zone index (`fe80::1%eth0`) names the local interface, not the peer.
  const address = clientAddress.split('%', 1)[0]!;
  if (isIPv4(address)) return address;
  if (!isIPv6(address)) return null;

  const groups = expandIPv6(address);
  if (groups === null) return null;
  // An IPv4-mapped address (`::ffff:192.0.2.1`) is the IPv4 peer of a dual-stack socket.
  if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) {
    const [high, low] = [groups[6]!, groups[7]!];
    return [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.');
  }
  return `${groups
    .slice(0, 4)
    .map((group) => group.toString(16))
    .join(':')}::/64`;
}

/**
 * The full client address, as stored in a sign-in record (identity design 10.2; data design 3.6,
 * `inet`): the IPv4 address, an IPv4-mapped IPv6 address as its IPv4 peer, or the IPv6 address in
 * its canonical text form. From the resolved client address, like {@link clientOriginOf};
 * `null` when there is no usable address.
 */
export function clientAddressOf(clientAddress: string | undefined): string | null {
  if (typeof clientAddress !== 'string' || clientAddress.length === 0) return null;
  const address = clientAddress.split('%', 1)[0]!;
  if (isIPv4(address)) return address;
  if (!isIPv6(address)) return null;
  const groups = expandIPv6(address);
  if (groups === null) return null;
  if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) {
    const [high, low] = [groups[6]!, groups[7]!];
    return [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.');
  }
  return groups.map((group) => group.toString(16)).join(':');
}

/**
 * The eight 16-bit groups of a valid IPv6 address, with an embedded IPv4 tail converted. Also
 * used by the CIDR matching of ADR-0037 (`platform/http/client-address-trust.ts`).
 */
export function expandIPv6(address: string): number[] | null {
  let text = address.toLowerCase();
  const tail = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (tail !== null) {
    const [a, b, c, d] = tail.slice(1).map(Number) as [number, number, number, number];
    text = `${text.slice(0, tail.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const parse = (part: string): number[] =>
    part === '' ? [] : part.split(':').map((group) => Number.parseInt(group, 16));
  const head = parse(halves[0]!);
  const rest = halves.length === 2 ? parse(halves[1]!) : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 ? missing !== 0 : missing < 0) return null;
  const groups = [...head, ...Array<number>(Math.max(missing, 0)).fill(0), ...rest];
  return groups.length === 8 && groups.every((group) => group >= 0 && group <= 0xffff)
    ? groups
    : null;
}
