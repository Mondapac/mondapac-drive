import { parseId, parseMarketId, Temporal } from '@mondapac-drive/shared-kernel';
import type { Id, MarketId } from '@mondapac-drive/shared-kernel';
import {
  lastSeenIsDue,
  openSession,
  SessionLifetimeError,
  sessionIsLive,
  type Session,
  type SessionLifetime,
} from './session';

const NOW = Temporal.Instant.from('2026-10-08T10:00:00Z');

function id<T extends string>(text: string): Id<T> {
  const parsed = parseId(text);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
}
function market(code: string): MarketId {
  const parsed = parseMarketId(code);
  if (!parsed.ok) throw new Error('bad market');
  return parsed.value;
}

// AU: 14 days idle, 30 days absolute; ZZ: 7 and 14 (config/markets/AU.json, ZZ.json).
describe.each<[string, SessionLifetime]>([
  ['AU', { idleTimeoutSeconds: 14 * 86_400, absoluteLifetimeSeconds: 30 * 86_400 }],
  ['ZZ', { idleTimeoutSeconds: 7 * 86_400, absoluteLifetimeSeconds: 14 * 86_400 }],
])('a courier session in %s (identity design 3.5, 6.1, 6.2)', (code, lifetime) => {
  const open = (): Session =>
    openSession({
      id: id<'Session'>('01990000-0000-7000-8000-00000000a001'),
      marketId: market(code),
      accountId: id<'Account'>('01990000-0000-7000-8000-000000000001'),
      population: 'courier',
      transport: 'bearer',
      lifetime,
      now: NOW,
    });

  it('fixes both lifetimes at creation and starts active', () => {
    const session = open();

    expect(session).toMatchObject({
      population: 'courier',
      merchantId: null,
      transport: 'bearer',
      label: null,
      createdAt: NOW,
      lastSeenAt: NOW,
      idleTimeoutSeconds: lifetime.idleTimeoutSeconds,
      absoluteExpiresAt: NOW.add({ seconds: lifetime.absoluteLifetimeSeconds }),
      revokedAt: null,
      revokedReason: null,
    });
    expect(Object.isFrozen(session)).toBe(true);
    expect(sessionIsLive(session, NOW)).toBe(true);
  });

  it('expires at the idle timeout after the last request, not a second later', () => {
    const session = open();
    const idleEnd = NOW.add({ seconds: lifetime.idleTimeoutSeconds });

    expect(sessionIsLive(session, idleEnd.subtract({ seconds: 1 }))).toBe(true);
    expect(sessionIsLive(session, idleEnd)).toBe(false);
  });

  it('expires at the absolute lifetime however recent the last request', () => {
    const session = {
      ...open(),
      lastSeenAt: NOW.add({ seconds: lifetime.absoluteLifetimeSeconds - 5 }),
    };
    const absoluteEnd = NOW.add({ seconds: lifetime.absoluteLifetimeSeconds });

    expect(sessionIsLive(session, absoluteEnd.subtract({ seconds: 1 }))).toBe(true);
    expect(sessionIsLive(session, absoluteEnd)).toBe(false);
  });

  it('is never live once revoked', () => {
    const session = { ...open(), revokedAt: NOW, revokedReason: 'sign-out' };

    expect(sessionIsLive(session, NOW)).toBe(false);
  });

  it('writes lastSeenAt at most once a minute', () => {
    const session = open();

    expect(lastSeenIsDue(session, NOW.add({ seconds: 59 }))).toBe(false);
    expect(lastSeenIsDue(session, NOW.add({ seconds: 60 }))).toBe(true);
  });
});

describe('openSession refuses', () => {
  const base = {
    id: id<'Session'>('01990000-0000-7000-8000-00000000a001'),
    marketId: market('ZZ'),
    accountId: id<'Account'>('01990000-0000-7000-8000-000000000001'),
    transport: 'cookie' as const,
    now: NOW,
  };

  it('an idle timeout longer than the absolute lifetime, or not positive', () => {
    for (const lifetime of [
      { idleTimeoutSeconds: 10, absoluteLifetimeSeconds: 5 },
      { idleTimeoutSeconds: 0, absoluteLifetimeSeconds: 5 },
    ]) {
      expect(() => openSession({ ...base, population: 'courier', lifetime })).toThrow(
        SessionLifetimeError,
      );
    }
  });

  it('a merchant session without its merchant, or a merchant on another population', () => {
    const lifetime = { idleTimeoutSeconds: 1, absoluteLifetimeSeconds: 2 };
    const key = { transport: 'api-key' as const, label: 'Shop' };
    expect(() => openSession({ ...base, ...key, population: 'merchant', lifetime })).toThrow(
      TypeError,
    );
    expect(() =>
      openSession({ ...base, population: 'courier', lifetime, merchantId: MERCHANT }),
    ).toThrow(TypeError);
  });

  it('an API key without its label, a label on another transport, or a label too long', () => {
    const lifetime = { idleTimeoutSeconds: 1, absoluteLifetimeSeconds: 2 };
    const merchant = { population: 'merchant' as const, merchantId: MERCHANT, lifetime };
    expect(() => openSession({ ...base, ...merchant, transport: 'api-key' })).toThrow(TypeError);
    expect(() =>
      openSession({ ...base, population: 'admin', lifetime, label: 'Shop' }),
    ).toThrow(TypeError);
    expect(() =>
      openSession({ ...base, ...merchant, transport: 'api-key', label: 'x'.repeat(65) }),
    ).toThrow(TypeError);
  });
});

const MERCHANT = id<'Merchant'>('01990000-0000-7000-8000-0000000000a1');

describe.each(['AU', 'ZZ'])('a merchant API key in %s (identity design 3.5)', (code) => {
  it('carries its merchant, its label and the lifetime it was given', () => {
    const session = openSession({
      id: id<'Session'>('01990000-0000-7000-8000-00000000a001'),
      marketId: market(code),
      accountId: id<'Account'>('01990000-0000-7000-8000-000000000001'),
      population: 'merchant',
      merchantId: MERCHANT,
      transport: 'api-key',
      label: 'Warehouse till',
      lifetime: { idleTimeoutSeconds: 12 * 3600, absoluteLifetimeSeconds: 24 * 3600 },
      now: NOW,
    });

    expect(session).toMatchObject({
      population: 'merchant',
      merchantId: MERCHANT,
      transport: 'api-key',
      label: 'Warehouse till',
      idleTimeoutSeconds: 12 * 3600,
      absoluteExpiresAt: NOW.add({ hours: 24 }),
    });
  });
});
