import { describe, expect, it } from 'vitest';
import { cidrContains, normalisePeer, parseAddress, parseCidr, parseCidrList } from './cidr.ts';

describe('parseCidr', () => {
  it.each([
    ['10.0.0.0/16'],
    ['203.0.113.0/24'],
    ['203.0.113.7/32'],
    ['2001:db8::/48'],
    ['2001:db8:1:2::7/128'],
  ])('accepts %s', (text) => {
    expect(() => parseCidr(text)).not.toThrow();
  });

  it.each([
    ['203.0.113.7', 'prefix length'],
    ['0.0.0.0/0', '0.0.0.0/0'],
    ['::/0', '::/0'],
    ['10.0.0.0/8', 'wider than /16'],
    ['2001:db8::/32', 'wider than /48'],
    ['10.0.0.1/16', 'host bits'],
    ['2001:db8::1/48', 'host bits'],
    ['::ffff:10.0.0.0/112', 'IPv4-mapped'],
    ['10.0.0.0/33', 'longer than 32'],
    ['not-an-ip/24', 'valid CIDR'],
    ['10.0.0.0/2x', 'valid CIDR'],
    ['fe80::/64%eth0', 'valid CIDR'],
    ['10.0.0.0/24/1', 'prefix length'],
  ])('refuses %s', (text, reason) => {
    expect(() => parseCidr(text)).toThrow(reason);
  });

  it('parses a comma list and refuses an empty entry', () => {
    expect(parseCidrList('10.0.0.0/16, 2001:db8::/48')).toHaveLength(2);
    expect(() => parseCidrList('10.0.0.0/16,')).toThrow();
  });
});

describe('parseAddress', () => {
  it('reads IPv4, IPv6, compressed and embedded IPv4 forms', () => {
    expect(parseAddress('203.0.113.7')).toEqual({ family: 4, value: 0xcb007107n });
    expect(parseAddress('::1')?.value).toBe(1n);
    expect(parseAddress('2001:db8::')?.value).toBe(0x20010db8n << 96n);
    expect(parseAddress('::ffff:203.0.113.7')?.value).toBe(0xffffcb007107n);
  });

  it.each([
    '',
    'a.b.c.d',
    '1.2.3',
    '1.2.3.4:80',
    '[::1]',
    'fe80::1%eth0',
    '1.2.3.4, 5.6.7.8',
    '::1::2',
  ])('refuses %j', (text) => {
    expect(parseAddress(text)).toBeNull();
  });
});

describe('cidrContains', () => {
  it('matches inside and not outside', () => {
    const v4 = parseCidr('203.0.113.0/24');
    expect(cidrContains(v4, '203.0.113.200')).toBe(true);
    expect(cidrContains(v4, '203.0.114.1')).toBe(false);
    const v6 = parseCidr('2001:db8:1::/48');
    expect(cidrContains(v6, '2001:db8:1:ffff::1')).toBe(true);
    expect(cidrContains(v6, '2001:db8:2::1')).toBe(false);
  });

  it('never matches across families, and an IPv4-mapped peer counts as its IPv4 address', () => {
    expect(cidrContains(parseCidr('203.0.113.0/24'), '2001:db8::1')).toBe(false);
    expect(cidrContains(parseCidr('203.0.113.0/24'), '::ffff:203.0.113.9')).toBe(true);
    expect(normalisePeer('::ffff:203.0.113.9')).toBe('203.0.113.9');
    expect(normalisePeer('2001:db8::1')).toBe('2001:db8::1');
  });
});
