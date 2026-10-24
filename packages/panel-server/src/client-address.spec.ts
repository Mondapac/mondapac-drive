import { describe, expect, it } from 'vitest';
import {
  MissingClientAddressError,
  parseClientAddressKey,
  signClientAddress,
  signForRequest,
} from './client-address.ts';

// The vectors of ADR-0037 ("Test vectors"): the API verifier reproduces the same values.
const PANEL_SECRET = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';
const STOREFRONT_SECRET = 'ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8=';
const T = 1791417600;

const key = (keyId: string, secret: string) => {
  const parsed = parseClientAddressKey({
    BFF_CLIENT_ADDRESS_KEY_ID: keyId,
    BFF_CLIENT_ADDRESS_SECRET: secret,
  });
  if (parsed === null) throw new Error('key expected');
  return parsed;
};

describe('signClientAddress', () => {
  it.each([
    [
      'vector 1',
      'panel',
      PANEL_SECRET,
      'AU',
      '203.0.113.7',
      'VBHNrLXY_bKDvCMXHp-hfnqKb98sQZ90DnvOVDTYIj8',
    ],
    [
      'vector 2',
      'panel',
      PANEL_SECRET,
      'ZZ',
      '203.0.113.7',
      'pdOR9xvYNH2KymwMOqkRAQiXndUffaIm8am5eyQTMjg',
    ],
    [
      'vector 3',
      'storefront',
      STOREFRONT_SECRET,
      'AU',
      '2001:db8:1:2::7',
      'b9XsWAV8xLo3H9Nark3wE-d0f01UHm4BaeIkOWnGkPE',
    ],
  ])('reproduces %s', (_name, keyId, secret, marketId, address, signature) => {
    expect(signClientAddress({ key: key(keyId, secret), marketId, address, nowSeconds: T })).toBe(
      `v1;k=${keyId};t=${T};a=${address};s=${signature}`,
    );
  });

  it('binds the proof to the Market', () => {
    const k = key('panel', PANEL_SECRET);
    const au = signClientAddress({ key: k, marketId: 'AU', address: '203.0.113.7', nowSeconds: T });
    const zz = signClientAddress({ key: k, marketId: 'ZZ', address: '203.0.113.7', nowSeconds: T });
    expect(au).not.toBe(zz);
  });

  it.each(['203.0.113.7, 198.51.100.1', 'fe80::1%eth0', '[2001:db8::1]', '203.0.113.7:443', ''])(
    'refuses %j as an address',
    (address) => {
      expect(() =>
        signClientAddress({
          key: key('panel', PANEL_SECRET),
          marketId: 'AU',
          address,
          nowSeconds: T,
        }),
      ).toThrow('one IP address');
    },
  );

  it('refuses a malformed Market or time', () => {
    const k = key('panel', PANEL_SECRET);
    expect(() =>
      signClientAddress({ key: k, marketId: 'au', address: '203.0.113.7', nowSeconds: T }),
    ).toThrow();
    expect(() =>
      signClientAddress({ key: k, marketId: 'AU', address: '203.0.113.7', nowSeconds: 1.5 }),
    ).toThrow();
  });
});

describe('parseClientAddressKey', () => {
  it('is off when both are unset', () => {
    expect(parseClientAddressKey({})).toBeNull();
  });

  it.each([
    [{ BFF_CLIENT_ADDRESS_KEY_ID: 'panel' }, 'together'],
    [{ BFF_CLIENT_ADDRESS_SECRET: PANEL_SECRET }, 'together'],
    [
      { BFF_CLIENT_ADDRESS_KEY_ID: 'Panel', BFF_CLIENT_ADDRESS_SECRET: PANEL_SECRET },
      'BFF_CLIENT_ADDRESS_KEY_ID',
    ],
    [{ BFF_CLIENT_ADDRESS_KEY_ID: 'panel', BFF_CLIENT_ADDRESS_SECRET: 'not base64!' }, 'base64'],
    [
      { BFF_CLIENT_ADDRESS_KEY_ID: 'panel', BFF_CLIENT_ADDRESS_SECRET: 'AAECAwQFBgcICQoLDA0ODw==' },
      '32 bytes',
    ],
  ])('fails start-up for %j', (env, message) => {
    expect(() => parseClientAddressKey(env)).toThrow(message);
  });

  it('never puts the secret in an error message', () => {
    try {
      parseClientAddressKey({
        BFF_CLIENT_ADDRESS_KEY_ID: 'panel',
        BFF_CLIENT_ADDRESS_SECRET: 'AAECAwQFBgcICQoLDA0ODw==',
      });
    } catch (error) {
      expect(String(error)).not.toContain('AAECAwQFBgcICQoLDA0ODw');
    }
  });
});

describe('signForRequest', () => {
  const key = { keyId: 'panel', secret: Buffer.from(PANEL_SECRET, 'base64') };

  it('signs the address the panel server set', () => {
    const headers = new Headers({ 'x-drive-client-address': '203.0.113.7' });
    expect(signForRequest({ key, marketId: 'AU', headers, nowSeconds: 1791417600 })).toContain(
      's=VBHNrLXY_bKDvCMXHp-hfnqKb98sQZ90DnvOVDTYIj8',
    );
  });

  it('ignores a browser-sent x-client-address and refuses without the internal header', () => {
    const headers = new Headers({ 'x-client-address': 'v1;k=panel;t=1;a=5.5.5.5;s=x' });
    expect(() => signForRequest({ key, marketId: 'AU', headers, nowSeconds: 1 })).toThrow(
      MissingClientAddressError,
    );
  });
});
