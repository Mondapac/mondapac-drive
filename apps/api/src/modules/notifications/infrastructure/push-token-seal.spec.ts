import { randomBytes } from 'node:crypto';
import type { ExpoPushToken } from '../domain/push-device';
import { PushTokenSeal, PushTokenSealError } from './push-token-seal';

const TOKEN = 'ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]' as ExpoPushToken;
const ACCOUNT = '0195f000-0000-7000-8000-0000000000a1';

describe('the push token seal', () => {
  const seal = new PushTokenSeal(randomBytes(32));

  it('opens what it sealed, for the same account, and never holds the clear token', () => {
    const sealed = seal.seal(TOKEN, ACCOUNT);
    expect(sealed).toMatch(/^v1\.[A-Za-z0-9_-]+$/);
    expect(sealed).not.toContain('xxxxxxxx');
    expect(seal.open(sealed, ACCOUNT)).toBe(TOKEN);
  });

  it('seals the same token differently each time', () => {
    expect(seal.seal(TOKEN, ACCOUNT)).not.toBe(seal.seal(TOKEN, ACCOUNT));
  });

  it('refuses another account, another key and a changed row', () => {
    const sealed = seal.seal(TOKEN, ACCOUNT);
    expect(() => seal.open(sealed, ACCOUNT.replace('a1', 'a2'))).toThrow(PushTokenSealError);
    expect(() => new PushTokenSeal(randomBytes(32)).open(sealed, ACCOUNT)).toThrow(
      PushTokenSealError,
    );
    const flipped = sealed.slice(0, -2) + (sealed.endsWith('A') ? 'B' : 'A') + sealed.slice(-1);
    expect(() => seal.open(flipped, ACCOUNT)).toThrow(PushTokenSealError);
    expect(() => seal.open('v2.' + sealed.slice(3), ACCOUNT)).toThrow(PushTokenSealError);
    expect(() => seal.open('v1.AAAA', ACCOUNT)).toThrow(PushTokenSealError);
  });

  it('finds a token by a keyed digest that depends on the key', () => {
    const key = randomBytes(32);
    expect(new PushTokenSeal(key).lookup(TOKEN)).toBe(new PushTokenSeal(key).lookup(TOKEN));
    expect(seal.lookup(TOKEN)).toMatch(/^[0-9a-f]{64}$/);
    expect(seal.lookup(TOKEN)).not.toBe(new PushTokenSeal(randomBytes(32)).lookup(TOKEN));
  });
});
