import { inspect } from 'node:util';
import {
  cidrContains,
  ClientAddressSecret,
  parseCidr,
  parseClientAddressTrust,
  parseIpAddress,
  type Cidr,
} from './client-address-trust';

// ADR-0037 decisions 4 and 5: the deployment settings and the start-up refusals.

const SECRET_A = Buffer.alloc(32, 1).toString('base64');
const SECRET_B = Buffer.alloc(32, 2).toString('base64');
const CIDRS = '10.20.0.0/16,fd00:20::/48';

function issuesOf(cidrs: string | undefined, keys: string | undefined): readonly string[] {
  return parseClientAddressTrust(cidrs, keys).issues;
}

function cidr(text: string): Cidr {
  const parsed = parseCidr(text);
  if (typeof parsed === 'string') throw new Error(parsed);
  return parsed;
}

describe('parseClientAddressTrust (ADR-0037)', () => {
  it.each([
    [undefined, undefined],
    ['', ''],
    ['  ', ' '],
  ])('is off when both are blank (%p, %p)', (cidrs, keys) => {
    expect(parseClientAddressTrust(cidrs, keys)).toEqual({ trust: null, issues: [] });
  });

  it('parses two keys, each bound to its own networks, for rotation and per-BFF revocation', () => {
    const { trust, issues } = parseClientAddressTrust(
      CIDRS,
      ` panel:10.20.1.0/24,fd00:20:0:1::/64:${SECRET_A} ; storefront:10.20.2.0/24:${SECRET_B} `,
    );

    expect(issues).toEqual([]);
    expect(trust?.bffCidrs.map((c) => c.text)).toEqual(['10.20.0.0/16', 'fd00:20::/48']);
    expect(trust?.keys.get('panel')?.cidrs.map((c) => c.text)).toEqual([
      '10.20.1.0/24',
      'fd00:20:0:1::/64',
    ]);
    expect(trust?.keys.get('storefront')?.cidrs.map((c) => c.text)).toEqual(['10.20.2.0/24']);
  });

  describe('refuses to start', () => {
    it.each<[string, string | undefined, string | undefined, RegExp]>([
      ['a CIDR list without keys', CIDRS, '', /CLIENT_ADDRESS_KEYS is empty/],
      [
        'keys without a CIDR list',
        '',
        `panel:10.20.1.0/24:${SECRET_A}`,
        /TRUSTED_BFF_CIDRS is empty/,
      ],
      [
        'duplicate keyIds',
        CIDRS,
        `panel:10.20.1.0/24:${SECRET_A};panel:10.20.1.0/24:${SECRET_B}`,
        /key "panel": the keyId is listed twice/,
      ],
      [
        'two keyIds sharing one key',
        CIDRS,
        `panel:10.20.1.0/24:${SECRET_A};storefront:10.20.2.0/24:${SECRET_A}`,
        /key "storefront": shares its secret with key "panel"/,
      ],
      [
        'an IPv4 prefix shorter than /16',
        '10.0.0.0/15',
        `p:10.0.0.0/16:${SECRET_A}`,
        /wider than \/16/,
      ],
      [
        'an IPv6 prefix shorter than /48',
        'fd00::/47',
        `p:fd00::/48:${SECRET_A}`,
        /wider than \/48/,
      ],
      [
        '0.0.0.0/0',
        '0.0.0.0/0',
        `p:10.20.1.0/24:${SECRET_A}`,
        /0\.0\.0\.0\/0 and ::\/0 are refused/,
      ],
      ['::/0', '::/0', `p:fd00:20::/48:${SECRET_A}`, /0\.0\.0\.0\/0 and ::\/0 are refused/],
      [
        'bad base64',
        CIDRS,
        'panel:10.20.1.0/24:not*base64!',
        /key "panel": the secret is not valid base64/,
      ],
      [
        'base64 without its padding',
        CIDRS,
        `panel:10.20.1.0/24:${SECRET_A.replace(/=+$/, '')}`,
        /the secret is not valid base64/,
      ],
      [
        'a key shorter than 32 bytes',
        CIDRS,
        `panel:10.20.1.0/24:${Buffer.alloc(31, 1).toString('base64')}`,
        /shorter than 32 bytes/,
      ],
      ['a key entry without CIDRs', CIDRS, `panel::${SECRET_A}`, /key "panel": names no CIDR/],
      ['a key entry of two parts', CIDRS, `panel:${SECRET_A}`, /must be keyId:cidrs:base64/],
      ['an empty key entry', CIDRS, `panel:10.20.1.0/24:${SECRET_A};;`, /entry 2: is empty/],
      ['a bad keyId', CIDRS, `Panel:10.20.1.0/24:${SECRET_A}`, /keyId must match/],
      [
        "a key's CIDR outside TRUSTED_BFF_CIDRS",
        CIDRS,
        `panel:10.30.1.0/24:${SECRET_A}`,
        /key "panel": CIDR 1 is not inside TRUSTED_BFF_CIDRS/,
      ],
      ['a CIDR without a prefix', '10.20.1.1', `p:10.20.1.1/32:${SECRET_A}`, /not a CIDR/],
      ['a CIDR with host bits set', '10.20.1.1/24', `p:10.20.1.0/24:${SECRET_A}`, /host bits set/],
      [
        'a prefix longer than the address',
        '10.20.1.0/33',
        `p:10.20.1.0/24:${SECRET_A}`,
        /prefix longer/,
      ],
      ['an IPv4-mapped range', '::ffff:10.20.0.0/112', `p:10.20.1.0/24:${SECRET_A}`, /IPv4-mapped/],
      ['an empty CIDR in the list', '10.20.0.0/16,', `p:10.20.1.0/24:${SECRET_A}`, /empty CIDR/],
    ])('on %s', (_label, cidrs, keys, expected) => {
      const { trust, issues } = parseClientAddressTrust(cidrs, keys);

      expect(trust).toBeNull();
      expect(issues.join('\n')).toMatch(expected);
    });

    it.each([
      ['secret and CIDR swapped', `panel:${SECRET_A}:10.20.1.0/24`],
      ['secret listed as a second CIDR', `panel:10.20.1.0/24,${SECRET_A}:${SECRET_B}`],
      ['secret in the CIDR list of a two-part tail', `panel:${SECRET_A},x:${SECRET_B}`],
    ])(
      'names a bad CIDR of a key entry by keyId and position, never by its text (%s, Hassan L2)',
      (_label, keys) => {
        const issues = issuesOf(CIDRS, keys);
        const text = issues.join('\n');

        expect(text).toMatch(/CLIENT_ADDRESS_KEYS key "panel": CIDR \d is not a CIDR/);
        for (const secret of [SECRET_A, SECRET_B, SECRET_A.slice(0, 16), SECRET_B.slice(0, 16)]) {
          expect(text).not.toContain(secret);
        }
      },
    );

    it('still quotes a bad TRUSTED_BFF_CIDRS entry, which holds no secret', () => {
      expect(issuesOf('10.20.0.0/16,nonsense', `p:10.20.1.0/24:${SECRET_A}`).join('\n')).toMatch(
        /TRUSTED_BFF_CIDRS: "nonsense" is not a CIDR/,
      );
    });

    it('never quotes a secret in a message', () => {
      const short = Buffer.alloc(16, 9).toString('base64');
      const issues = [
        ...issuesOf(CIDRS, `panel:10.20.1.0/24:${short}`),
        ...issuesOf(CIDRS, `panel:10.20.1.0/24:${SECRET_A};x:10.20.1.0/24:${SECRET_A}`),
        ...issuesOf(CIDRS, `panel:10.99.1.0/24:${SECRET_A}`),
      ];

      expect(issues.length).toBeGreaterThanOrEqual(3);
      for (const text of [short, SECRET_A]) expect(issues.join('\n')).not.toContain(text);
    });
  });

  it('accepts the narrowest allowed prefixes, /16 and /48', () => {
    expect(
      issuesOf('10.20.0.0/16,fd00:20::/48', `p:10.20.0.0/16,fd00:20::/48:${SECRET_A}`),
    ).toEqual([]);
  });
});

describe('ClientAddressSecret', () => {
  it('prints, inspects and serialises as a marker only', () => {
    const secret = new ClientAddressSecret(Buffer.alloc(32, 0xab));

    expect(String(secret)).toBe('[secret]');
    expect(JSON.stringify({ secret })).toBe('{"secret":"[secret]"}');
    expect(inspect({ secret })).not.toMatch(/ab|171/);
  });
});

describe('CIDR matching', () => {
  it.each<[string, string, boolean]>([
    ['10.20.0.0/16', '10.20.255.1', true],
    ['10.20.0.0/16', '10.21.0.1', false],
    ['127.0.0.1/32', '127.0.0.1', true],
    ['127.0.0.1/32', '127.0.0.2', false],
    ['fd00:20::/48', 'fd00:20:0:ffff::1', true],
    ['fd00:20::/48', 'fd00:21::1', false],
    // Families never match each other.
    ['10.20.0.0/16', '::ffff:10.20.0.1', false],
  ])('%s contains %s: %s', (range, address, expected) => {
    const parsed = parseIpAddress(address);
    expect(parsed).not.toBeNull();
    expect(cidrContains(cidr(range), parsed!)).toBe(expected);
  });

  it.each(['fe80::1%eth0', '10.0.0.1:80', '[::1]', '10.0.0', '', 'host'])(
    'is not an address: %p',
    (text) => {
      expect(parseIpAddress(text)).toBeNull();
    },
  );
});
