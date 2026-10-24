import * as crypto from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { Logger } from '@nestjs/common';
import { Temporal } from '@mondapac-drive/shared-kernel';
import { FixedClock } from '@mondapac-drive/shared-kernel/testing';
import type { Request, Response } from 'express';
import { clientAddressOf, clientOriginOf } from '../rate-limit/client-origin';
import {
  CLIENT_ADDRESS_EXEMPT_PATHS,
  clientAddressFrom,
  clientAddressResolver,
  type ClientAddressRefusal,
} from './client-address';
import { parseClientAddressTrust, type ClientAddressTrust } from './client-address-trust';

// The HMAC and the comparison are wrapped so a test can see whether, and how, they ran.
jest.mock('node:crypto', () => {
  const actual = jest.requireActual<typeof crypto>('node:crypto');
  return {
    ...actual,
    createHmac: jest.fn(actual.createHmac),
    timingSafeEqual: jest.fn(actual.timingSafeEqual),
  };
});
const createHmac = crypto.createHmac as unknown as jest.Mock;
const timingSafeEqual = crypto.timingSafeEqual as unknown as jest.Mock;

// ADR-0037 decisions 2, 3, 6 and 7, and the test vectors of the ADR.

const PANEL_KEY = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8='; // bytes 0x00 to 0x1f
const STOREFRONT_KEY = 'ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8='; // bytes 0x20 to 0x3f
const T = 1_791_417_600; // 2026-10-08T00:00:00Z
const AT_T = Temporal.Instant.fromEpochMilliseconds(T * 1000);

/** The ADR's vectors: [keyId, address, Market, s]. */
const VECTORS = [
  ['panel', '203.0.113.7', 'AU', 'VBHNrLXY_bKDvCMXHp-hfnqKb98sQZ90DnvOVDTYIj8'],
  ['panel', '203.0.113.7', 'ZZ', 'pdOR9xvYNH2KymwMOqkRAQiXndUffaIm8am5eyQTMjg'],
  ['storefront', '2001:db8:1:2::7', 'AU', 'b9XsWAV8xLo3H9Nark3wE-d0f01UHm4BaeIkOWnGkPE'],
] as const;

const PANEL_HOST = '10.20.1.5';
const STOREFRONT_HOST = '10.20.2.5';
const OUTSIDE_HOST = '198.51.100.20';

function trust(): ClientAddressTrust {
  const parsed = parseClientAddressTrust(
    '10.20.0.0/16,fd00:20::/48',
    `panel:10.20.1.0/24,fd00:20:0:1::/64:${PANEL_KEY};storefront:10.20.2.0/24:${STOREFRONT_KEY}`,
  );
  if (parsed.trust === null) throw new Error(parsed.issues.join('\n'));
  return parsed.trust;
}

/** A proof signed with Node's own HMAC, independently of the code under test. */
function proof(
  keyId: string,
  address: string,
  market: string,
  options: { t?: number; key?: string } = {},
): string {
  const t = String(options.t ?? T);
  const key = Buffer.from(
    options.key ?? (keyId === 'storefront' ? STOREFRONT_KEY : PANEL_KEY),
    'base64',
  );
  const s = jest
    .requireActual<typeof crypto>('node:crypto')
    .createHmac('sha256', key)
    .update(`v1\n${keyId}\n${t}\n${address}\n${market}`, 'utf8')
    .digest('base64url');
  return `v1;k=${keyId};t=${t};a=${address};s=${s}`;
}

interface Outcome {
  readonly next: boolean;
  readonly status?: number;
  readonly body?: unknown;
  readonly address: string | undefined;
  readonly request: IncomingMessage;
}

/**
 * Runs the middleware on a request from `socket` with the given header lines (repeated names
 * stay repeated in `rawHeaders`; `headers` joins them as Node does).
 */
function run(
  options: {
    socket?: string | undefined;
    lines?: readonly [string, string][];
    path?: string;
    trust?: ClientAddressTrust | null;
    clock?: FixedClock;
  } = {},
): Outcome {
  const lines = options.lines ?? [];
  const headers: Record<string, string> = {};
  for (const [name, value] of lines) {
    const key = name.toLowerCase();
    headers[key] = headers[key] === undefined ? value : `${headers[key]}, ${value}`;
  }
  const path = options.path ?? '/identity/customer/sign-in';
  const request = {
    headers,
    rawHeaders: lines.flat(),
    socket: { remoteAddress: 'socket' in options ? options.socket : PANEL_HOST },
    originalUrl: path,
    url: path,
    id: 'test-correlation-0001',
  } as unknown as Request;
  const answer: { status?: number; body?: unknown } = {};
  const response = {
    status(code: number) {
      answer.status = code;
      return this;
    },
    json(body: unknown) {
      answer.body = body;
      return this;
    },
  } as unknown as Response;
  let next = false;
  clientAddressResolver({
    trust: options.trust === undefined ? trust() : options.trust,
    clock: options.clock ?? new FixedClock(AT_T),
  })(request, response, () => {
    next = true;
  });
  return { next, ...answer, address: clientAddressFrom(request), request };
}

const REFUSED = { statusCode: 400, code: 'client-address.untrusted' };

describe('clientAddressResolver (ADR-0037)', () => {
  let warn: jest.SpyInstance;

  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    createHmac.mockClear();
    timingSafeEqual.mockClear();
  });
  afterEach(() => warn.mockRestore());

  /** Asserts a refusal: 400, never `next`, no address, and the one log line with its reason. */
  function expectRefused(outcome: Outcome, reason: ClientAddressRefusal, keyId: string | null) {
    expect(outcome).toMatchObject({ next: false, status: 400, body: REFUSED, address: undefined });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith({
      msg: 'client-address.untrusted',
      reason,
      keyId,
      correlationId: 'test-correlation-0001',
    });
  }

  describe('the test vectors', () => {
    it.each(VECTORS)('accepts %s / %s / %s', (keyId, address, market, s) => {
      const host = keyId === 'storefront' ? STOREFRONT_HOST : PANEL_HOST;
      const header = `v1;k=${keyId};t=${T};a=${address};s=${s}`;

      expect(proof(keyId, address, market)).toBe(header);
      const outcome = run({
        socket: host,
        lines: [
          ['x-market-id', market],
          ['x-client-address', header],
        ],
      });

      expect(outcome).toMatchObject({ next: true, address });
      expect(warn).not.toHaveBeenCalled();
    });

    it('refuses vector 1 sent with the other Market', () => {
      const [, address, , s] = VECTORS[0];
      const outcome = run({
        lines: [
          ['x-market-id', 'ZZ'],
          ['x-client-address', `v1;k=panel;t=${T};a=${address};s=${s}`],
        ],
      });

      expectRefused(outcome, 'signature-invalid', 'panel');
    });
  });

  describe('the resolved address goes through the existing canonical forms', () => {
    it.each<[string, string, string]>([
      ['::ffff:203.0.113.9', '203.0.113.9', '203.0.113.9'],
      ['2001:DB8:1:2:0:0:0:7', '2001:db8:1:2::/64', '2001:db8:1:2:0:0:0:7'],
    ])('%s is origin %s and address %s', (address, origin, stored) => {
      const outcome = run({
        lines: [
          ['x-market-id', 'AU'],
          ['x-client-address', proof('panel', address, 'AU')],
        ],
      });

      expect(outcome.next).toBe(true);
      expect(clientOriginOf(outcome.address)).toBe(origin);
      expect(clientAddressOf(outcome.address)).toBe(stored);
    });
  });

  describe('with the feature off (both variables empty)', () => {
    it.each(['203.0.113.50', '::ffff:10.20.1.5', undefined])(
      'is the socket address, as before (%p)',
      (socket) => {
        const outcome = run({ trust: null, socket, lines: [['x-market-id', 'AU']] });

        expect(outcome).toMatchObject({ next: true, address: socket });
        expect(warn).not.toHaveBeenCalled();
      },
    );

    it('ignores the forwarded headers', () => {
      const outcome = run({
        trust: null,
        socket: '203.0.113.50',
        lines: [
          ['x-forwarded-for', '198.51.100.1'],
          ['forwarded', 'for=198.51.100.2'],
          ['x-real-ip', '198.51.100.3'],
        ],
      });

      expect(outcome).toMatchObject({ next: true, address: '203.0.113.50' });
    });

    it('refuses a request that carries the header', () => {
      const outcome = run({
        trust: null,
        lines: [
          ['x-market-id', 'AU'],
          ['x-client-address', proof('panel', '203.0.113.7', 'AU')],
        ],
      });

      expectRefused(outcome, 'disabled', null);
    });
  });

  describe('with the feature on', () => {
    it('answers the socket address to a client outside the BFF networks', () => {
      const outcome = run({
        socket: OUTSIDE_HOST,
        lines: [
          ['x-market-id', 'AU'],
          ['x-forwarded-for', '198.51.100.1'],
        ],
      });

      expect(outcome).toMatchObject({ next: true, address: OUTSIDE_HOST });
    });

    it('treats an IPv4-mapped BFF socket as the IPv4 BFF', () => {
      const outcome = run({ socket: `::ffff:${PANEL_HOST}`, lines: [['x-market-id', 'AU']] });

      expectRefused(outcome, 'missing', null);
    });

    it('accepts a key over IPv6 from its IPv6 network', () => {
      const outcome = run({
        socket: 'fd00:20:0:1::9',
        lines: [
          ['x-market-id', 'ZZ'],
          ['x-client-address', proof('panel', '203.0.113.7', 'ZZ')],
        ],
      });

      expect(outcome).toMatchObject({ next: true, address: '203.0.113.7' });
    });

    it('ignores X-Forwarded-For next to a valid proof', () => {
      const outcome = run({
        lines: [
          ['x-market-id', 'AU'],
          ['x-forwarded-for', '198.51.100.1'],
          ['x-client-address', proof('panel', '203.0.113.7', 'AU')],
        ],
      });

      expect(outcome.address).toBe('203.0.113.7');
    });

    it('takes both keys during a rotation', () => {
      const rotating = parseClientAddressTrust(
        '10.20.0.0/16',
        `panel:10.20.1.0/24:${PANEL_KEY};panel-2:10.20.1.0/24:${STOREFRONT_KEY}`,
      ).trust;
      const lines = (keyId: string, key: string): [string, string][] => [
        ['x-market-id', 'AU'],
        ['x-client-address', proof(keyId, '203.0.113.7', 'AU', { key })],
      ];

      expect(run({ trust: rotating, lines: lines('panel', PANEL_KEY) }).next).toBe(true);
      expect(run({ trust: rotating, lines: lines('panel-2', STOREFRONT_KEY) }).next).toBe(true);
    });

    describe('refuses, never falling back to the socket', () => {
      const valid = (): [string, string][] => [
        ['x-market-id', 'AU'],
        ['x-client-address', proof('panel', '203.0.113.7', 'AU')],
      ];

      it('a proof sent from outside the BFF networks', () => {
        expectRefused(run({ socket: OUTSIDE_HOST, lines: valid() }), 'source-untrusted', null);
      });

      it('a request from a BFF network without a proof', () => {
        expectRefused(run({ lines: [['x-market-id', 'AU']] }), 'missing', null);
      });

      it('a repeated header', () => {
        const header = proof('panel', '203.0.113.7', 'AU');
        const outcome = run({
          lines: [
            ['x-market-id', 'AU'],
            ['x-client-address', header],
            ['X-Client-Address', header],
          ],
        });

        expectRefused(outcome, 'repeated', null);
      });

      it.each([
        ['an empty header', ''],
        ['another version', proof('panel', '203.0.113.7', 'AU').replace('v1;', 'v2;')],
        ['a list of addresses', `v1;k=panel;t=${T};a=203.0.113.7,198.51.100.1;s=${'A'.repeat(43)}`],
        ['a zone index', `v1;k=panel;t=${T};a=fe80::1%eth0;s=${'A'.repeat(43)}`],
        ['a port', `v1;k=panel;t=${T};a=203.0.113.7:443;s=${'A'.repeat(43)}`],
        ['brackets', `v1;k=panel;t=${T};a=[2001:db8::1];s=${'A'.repeat(43)}`],
        ['an invalid address', `v1;k=panel;t=${T};a=999.0.113.7;s=${'A'.repeat(43)}`],
        ['a short signature', `v1;k=panel;t=${T};a=203.0.113.7;s=${'A'.repeat(42)}`],
        ['a padded signature', `v1;k=panel;t=${T};a=203.0.113.7;s=${'A'.repeat(43)}=`],
        ['a negative time', `v1;k=panel;t=-${T};a=203.0.113.7;s=${'A'.repeat(43)}`],
        ['an upper-case keyId', `v1;k=Panel;t=${T};a=203.0.113.7;s=${'A'.repeat(43)}`],
        ['fields out of order', `v1;t=${T};k=panel;a=203.0.113.7;s=${'A'.repeat(43)}`],
        ['an extra field', `${proof('panel', '203.0.113.7', 'AU')};x=1`],
      ])('a malformed header: %s', (_label, header) => {
        const outcome = run({
          lines: [
            ['x-market-id', 'AU'],
            ['x-client-address', header],
          ],
        });

        expectRefused(outcome, 'malformed', null);
      });

      it.each<[string, [string, string][]]>([
        ['absent', []],
        [
          'repeated',
          [
            ['x-market-id', 'AU'],
            ['x-market-id', 'AU'],
          ],
        ],
      ])('a proof whose Market header is %s', (_label, market) => {
        const outcome = run({
          lines: [...market, ['x-client-address', proof('panel', '203.0.113.7', 'AU')]],
        });

        expectRefused(outcome, 'market-missing', null);
      });

      it('an unknown key, without computing an HMAC', () => {
        const outcome = run({
          lines: [
            ['x-market-id', 'AU'],
            ['x-client-address', proof('admin', '203.0.113.7', 'AU')],
          ],
        });

        expectRefused(outcome, 'key-unknown', null);
        expect(createHmac).not.toHaveBeenCalled();
      });

      it("a key sent from another BFF's network (per-key binding), without computing an HMAC", () => {
        const outcome = run({
          socket: STOREFRONT_HOST,
          lines: [
            ['x-market-id', 'AU'],
            ['x-client-address', proof('panel', '203.0.113.7', 'AU')],
          ],
        });

        expectRefused(outcome, 'key-source-mismatch', 'panel');
        expect(createHmac).not.toHaveBeenCalled();
      });

      it.each([61, -61, 3600])(
        'a proof %i seconds off the Clock, without computing an HMAC',
        (offset) => {
          const outcome = run({
            lines: [
              ['x-market-id', 'AU'],
              ['x-client-address', proof('panel', '203.0.113.7', 'AU', { t: T + offset })],
            ],
          });

          expectRefused(outcome, 'stale', 'panel');
          expect(createHmac).not.toHaveBeenCalled();
        },
      );

      it('a signature that does not match, compared in constant time after a length check', () => {
        const header = proof('panel', '203.0.113.7', 'AU');
        const tampered = header.replace('a=203.0.113.7', 'a=203.0.113.8');
        const outcome = run({
          lines: [
            ['x-market-id', 'AU'],
            ['x-client-address', tampered],
          ],
        });

        expectRefused(outcome, 'signature-invalid', 'panel');
        expect(timingSafeEqual).toHaveBeenCalledTimes(1);
        const [given, expected] = timingSafeEqual.mock.calls[0] as [Buffer, Buffer];
        expect(given.length).toBe(32);
        expect(expected.length).toBe(32);
      });

      it('vector 1 with a non-canonical last character that decodes to the same bytes (Hassan L1)', () => {
        const [keyId, address, market, s] = VECTORS[0];
        // '8' is 111100 and '9' is 111101: the two low bits of the 43rd character are unused.
        const respelled = `${s.slice(0, -1)}9`;
        expect(s.endsWith('8')).toBe(true);
        expect(Buffer.from(respelled, 'base64url')).toEqual(Buffer.from(s, 'base64url'));

        const outcome = run({
          lines: [
            ['x-market-id', market],
            ['x-client-address', `v1;k=${keyId};t=${T};a=${address};s=${respelled}`],
          ],
        });

        expectRefused(outcome, 'signature-invalid', 'panel');
      });

      it('a signature under another key', () => {
        const outcome = run({
          lines: [
            ['x-market-id', 'AU'],
            ['x-client-address', proof('panel', '203.0.113.7', 'AU', { key: STOREFRONT_KEY })],
          ],
        });

        expectRefused(outcome, 'signature-invalid', 'panel');
      });
    });

    it.each([60, -60, 0])(
      'accepts a proof %i seconds off the Clock (the skew is ±60 s)',
      (offset) => {
        const outcome = run({
          lines: [
            ['x-market-id', 'AU'],
            ['x-client-address', proof('panel', '203.0.113.7', 'AU', { t: T + offset })],
          ],
        });

        expect(outcome.next).toBe(true);
        expect(timingSafeEqual).toHaveBeenCalledTimes(1);
      },
    );

    it('reads the time from the injected Clock only', () => {
      const clock = new FixedClock(AT_T);
      const lines: [string, string][] = [
        ['x-market-id', 'AU'],
        ['x-client-address', proof('panel', '203.0.113.7', 'AU')],
      ];
      clock.advance(Temporal.Duration.from({ seconds: 61 }));

      expect(run({ clock, lines }).next).toBe(false);
      clock.set(AT_T);
      expect(run({ clock, lines }).next).toBe(true);
    });
  });

  describe('the health probes', () => {
    it.each([...CLIENT_ADDRESS_EXEMPT_PATHS, '/health?probe=1'])(
      '%s is exempt, from a BFF network without a proof',
      (path) => {
        const outcome = run({ path, lines: [] });

        expect(outcome).toMatchObject({ next: true, address: undefined });
        expect(warn).not.toHaveBeenCalled();
      },
    );

    it.each(['/health/', '/healthz', '/health/other', '/identity/health'])(
      'only those exact paths: %s is not',
      (path) => {
        expectRefused(run({ path, lines: [] }), 'missing', null);
      },
    );
  });

  describe('logging (decision 7)', () => {
    it('never logs the address, the signature, the header, the Market or a key', () => {
      const header = proof('panel', '203.0.113.7', 'AU');
      const signature = header.split(';s=')[1]!;
      run({
        lines: [
          ['x-market-id', 'ZZ'],
          ['x-client-address', header],
        ],
      });
      run({ socket: OUTSIDE_HOST, lines: [['x-client-address', header]] });
      run({ lines: [['x-client-address', proof('nobody', '203.0.113.7', 'AU')]] });

      const logged = JSON.stringify(warn.mock.calls);
      expect(warn).toHaveBeenCalledTimes(3);
      for (const secret of [
        '203.0.113.7',
        PANEL_HOST,
        OUTSIDE_HOST,
        signature,
        header,
        'nobody',
        '"ZZ"',
        PANEL_KEY,
      ]) {
        expect(logged).not.toContain(secret);
      }
    });
  });

  it('gives a request that did not pass the middleware no address (readers fail closed)', () => {
    const request = { socket: { remoteAddress: '203.0.113.7' } } as unknown as IncomingMessage;

    expect(clientAddressFrom(request)).toBeUndefined();
  });
});
