import { clientAddressOf, clientOriginOf } from './client-origin';

describe('clientOriginOf (identity design 6.8, HF3)', () => {
  it.each([
    ['an IPv4 address', '203.0.113.7', '203.0.113.7'],
    ['an IPv4-mapped IPv6 address', '::ffff:203.0.113.7', '203.0.113.7'],
    ['an IPv4-mapped address in hex', '::ffff:cb00:7107', '203.0.113.7'],
    ['the IPv4 loopback seen on a dual-stack socket', '::ffff:127.0.0.1', '127.0.0.1'],
    ['a full IPv6 address', '2001:0db8:0001:0002:0003:0004:0005:0006', '2001:db8:1:2::/64'],
    ['a compressed IPv6 address', '2001:db8::1', '2001:db8:0:0::/64'],
    ['the IPv6 loopback', '::1', '0:0:0:0::/64'],
    ['an upper-case IPv6 address', '2001:DB8:A:B::1', '2001:db8:a:b::/64'],
    ['a link-local address with a zone', 'fe80::1%eth0', 'fe80:0:0:0::/64'],
  ])('keys %s', (_case, address, origin) => {
    expect(clientOriginOf(address)).toBe(origin);
  });

  it('puts every address of one IPv6 /64 on one origin (address rotation)', () => {
    const origins = new Set(
      ['2001:db8:1:2::1', '2001:db8:1:2::ffff', '2001:db8:1:2:aaaa:bbbb:cccc:dddd'].map(
        clientOriginOf,
      ),
    );

    expect([...origins]).toEqual(['2001:db8:1:2::/64']);
    expect(clientOriginOf('2001:db8:1:3::1')).not.toBe('2001:db8:1:2::/64');
  });

  it.each([
    ['no address', undefined],
    ['an empty address', ''],
    ['a host name', 'example.com'],
    ['a forwarded-header list', '198.51.100.1, 203.0.113.7'],
  ])('answers null for %s, so the limiter fails closed', (_case, address) => {
    expect(clientOriginOf(address)).toBeNull();
  });
});

describe('clientAddressOf (identity design 10.2: the address of a sign-in record)', () => {
  it.each([
    ['an IPv4 address', '203.0.113.7', '203.0.113.7'],
    ['an IPv4-mapped IPv6 address', '::ffff:203.0.113.7', '203.0.113.7'],
    ['a compressed IPv6 address', '2001:db8::1', '2001:db8:0:0:0:0:0:1'],
    ['an upper-case IPv6 address with a zone', 'FE80::A%eth0', 'fe80:0:0:0:0:0:0:a'],
  ])('keeps the whole of %s', (_case, address, stored) => {
    expect(clientAddressOf(address)).toBe(stored);
  });

  it.each([
    ['no address', undefined],
    ['a host name', 'example.com'],
    ['a forwarded-header list', '198.51.100.1, 203.0.113.7'],
  ])('answers null for %s', (_case, address) => {
    expect(clientAddressOf(address)).toBeNull();
  });
});
