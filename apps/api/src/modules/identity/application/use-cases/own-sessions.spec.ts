import { parseId, Temporal } from '@mondapac-drive/shared-kernel';
import type { Id, Population } from '@mondapac-drive/shared-kernel';
import {
  FixedClock,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac-drive/shared-kernel/testing';
import { fakeHashOf, IdentityFakes } from '../../../../../test/support/identity-fakes';
import {
  TEST_LOCALE_CONFIG_DIRS,
  TEST_MARKET_CONFIG_DIRS,
  TEST_MARKET_IDS,
  TEST_MARKETS,
} from '../../../../../test/support/test-config';
import type { AccessDecision, AuthorisationCheck } from '../../../../platform/authz';
import { createUseCaseGate } from '../../../../platform/authz/use-case-gate';
import type { EventDelivery } from '../../../../platform/events/event-delivery';
import { loadLocaleCatalogues } from '../../../../platform/i18n/locale-catalogues';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import { PLATFORM_TENANT_ID } from '../../../../platform/market-context/tenant';
import type { DeviceCode } from '../../domain/device';
import { openSession } from '../../domain/session';
import { CatalogueMailComposer } from '../../infrastructure/mail/mail-catalogue';
import { MarketConfigIdentityPolicy } from '../../infrastructure/market-config-identity-policy';
import type { IdentityMarketPolicy } from '../ports/identity-market-policy';
import type { ThrottleKeys } from '../ports/session-secrets';
import { ListOwnSessions } from './list-own-sessions.use-case';
import { SendOtherSessionsSignedOutMail } from './send-other-sessions-signed-out-mail.use-case';
import { SignOutOtherSessions } from './sign-out-other-sessions.use-case';

// The holder's own signed-in devices and "sign out of all other devices" (profile package 4),
// for both Market fixtures.

const START = Temporal.Instant.from('2026-10-16T10:00:00Z');
const id = <T extends string>(text: string): Id<T> => {
  const parsed = parseId(text);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const ADMIN_ID = id<'Account'>('01990000-0000-7000-8000-0000000000a1');
const OTHER_ADMIN_ID = id<'Account'>('01990000-0000-7000-8000-0000000000a2');
const COURIER_ID = id<'Account'>('01990000-0000-7000-8000-0000000000b1');
const MERCHANT_ACCOUNT_ID = id<'Account'>('01990000-0000-7000-8000-0000000000c1');
const MERCHANT_ID = id<'Merchant'>('01990000-0000-7000-8000-0000000000d1');
const CURRENT = id<'Session'>('01990000-0000-7000-8000-00000000a001');
const LAPTOP = id<'Session'>('01990000-0000-7000-8000-00000000a002');
const PHONE = id<'Session'>('01990000-0000-7000-8000-00000000a003');
const IDLE = id<'Session'>('01990000-0000-7000-8000-00000000a004');
const SIGNED_OUT = id<'Session'>('01990000-0000-7000-8000-00000000a005');
const OTHER_ACCOUNTS = id<'Session'>('01990000-0000-7000-8000-00000000a006');
const NEW_DEVICE = id<'Session'>('01990000-0000-7000-8000-00000000a007');
const LIFETIME = { idleTimeoutSeconds: 3600, absoluteLifetimeSeconds: 12 * 3600 };
const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const policy = new MarketConfigIdentityPolicy(markets);
const composer = new CatalogueMailComposer(markets, loadLocaleCatalogues(TEST_LOCALE_CONFIG_DIRS));
const keys: ThrottleKeys = {
  account: (market, population, email) => Buffer.from(`${market.marketId}|${population}|${email}`),
  accountOrigin: (market, population, email, origin) =>
    Buffer.from(`${market.marketId}|${population}|${email}|${origin}`),
  origin: (market, origin) => Buffer.from(`${market.marketId}|${origin}`),
};
let deliveries = 0;
function deliveryOf(): EventDelivery {
  deliveries += 1;
  return {
    eventId: `0199ffff-0000-7000-8000-${String(deliveries).padStart(12, '0')}` as Id<'event'>,
    subscriber: 'identity.other-sessions-signed-out-mail',
    attempt: 1,
  };
}
const allow: AuthorisationCheck = {
  check: (): Promise<AccessDecision> => Promise.resolve({ allowed: true }),
};

describe.each(TEST_MARKETS)('own sessions in market %s', (code) => {
  const market = testMarketContext(code, PLATFORM_TENANT_ID);
  const gate = createUseCaseGate(markets, allow);
  let fakes: IdentityFakes;

  function seedAccount(accountId: Id<'Account'>, population: Population) {
    fakes.seedAccount({
      id: accountId,
      marketId: market.marketId,
      population,
      email: { typed: `${accountId}@example.com`, normalized: `${accountId}@example.com` },
      displayName: 'Amina Rahman',
      status: 'active',
      emailVerifiedAt: START.subtract({ hours: 48 }),
      signedUpAt: START.subtract({ hours: 49 }),
      createdAt: START.subtract({ hours: 49 }),
      version: 3,
      credential: { passwordHash: fakeHashOf('x'), changedAt: START.subtract({ hours: 49 }) },
    });
  }

  function seedSession(
    sessionId: Id<'Session'>,
    accountId: Id<'Account'>,
    openedMinutesAgo: number,
    lastSeenMinutesAgo: number,
    device: DeviceCode | null,
    population: 'admin' | 'courier' = 'admin',
  ) {
    const opened = openSession({
      id: sessionId,
      marketId: market.marketId,
      accountId,
      population,
      transport: population === 'admin' ? 'cookie' : 'bearer',
      device,
      lifetime: LIFETIME,
      now: START.subtract({ minutes: openedMinutesAgo }),
    });
    void fakes.sessionRepository.add(
      market,
      { ...opened, lastSeenAt: START.subtract({ minutes: lastSeenMinutesAgo }) },
      new Uint8Array(32).fill(Number.parseInt(sessionId.slice(-2), 16)),
    );
  }

  beforeEach(() => {
    fakes = new IdentityFakes();
    seedAccount(ADMIN_ID, 'admin');
    seedAccount(OTHER_ADMIN_ID, 'admin');
    seedSession(CURRENT, ADMIN_ID, 30, 0, 'chrome.windows');
    seedSession(LAPTOP, ADMIN_ID, 300, 5, 'safari.macos');
    seedSession(PHONE, ADMIN_ID, 200, 20, null);
    // Past its one-hour idle timeout: not live, so neither listed nor counted.
    seedSession(IDLE, ADMIN_ID, 400, 90, 'firefox.linux');
    seedSession(SIGNED_OUT, ADMIN_ID, 100, 10, 'edge.windows');
    void fakes.sessionRepository.revoke(
      market,
      SIGNED_OUT,
      ADMIN_ID,
      'sign-out',
      START.subtract({ minutes: 9 }),
    );
    seedSession(OTHER_ACCOUNTS, OTHER_ADMIN_ID, 50, 1, 'chrome.android');
  });

  const deps = (clock = new FixedClock(START), marketPolicy: IdentityMarketPolicy = policy) => ({
    unitOfWork: fakes.unitOfWork,
    accounts: fakes.accountRepository,
    sessions: fakes.sessionRepository,
    throttles: fakes.throttleRepository,
    keys,
    outbox: fakes.outbox,
    policy: marketPolicy,
    audit: fakes.audit,
    clock,
  });
  const signedOutEvents = () =>
    fakes.events.filter((e) => e.type === 'identity.account-other-sessions-signed-out.v1');
  const contextOf = (
    population: Population,
    accountId: Id<'Account'>,
    sessionId: Id<'Session'> = CURRENT,
  ) =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population,
        accountId,
        sessionId,
        merchantId: population === 'merchant' ? MERCHANT_ID : null,
      }),
    );
  const sessionOf = (sessionId: Id<'Session'>) => fakes.sessions.get(sessionId)!.session;

  describe('ListOwnSessions', () => {
    it('lists the live sessions of the own account only, the current one first', async () => {
      const result = await new ListOwnSessions(gate, deps()).execute(
        contextOf('admin', ADMIN_ID),
        {},
      );
      expect(result).toEqual({
        ok: true,
        value: {
          items: [
            {
              device: 'chrome.windows',
              signedInAt: START.subtract({ minutes: 30 }).toString(),
              lastActiveAt: START.toString(),
              current: true,
            },
            {
              device: 'safari.macos',
              signedInAt: START.subtract({ minutes: 300 }).toString(),
              lastActiveAt: START.subtract({ minutes: 5 }).toString(),
              current: false,
            },
            {
              device: null,
              signedInAt: START.subtract({ minutes: 200 }).toString(),
              lastActiveAt: START.subtract({ minutes: 20 }).toString(),
              current: false,
            },
          ],
        },
      });
    });

    it('answers no session id, token or address', async () => {
      const result = await new ListOwnSessions(gate, deps()).execute(
        contextOf('admin', ADMIN_ID),
        {},
      );
      if (!result.ok) throw new Error('expected the list');
      for (const item of result.value.items) {
        expect(Object.keys(item).sort()).toEqual([
          'current',
          'device',
          'lastActiveAt',
          'signedInAt',
        ]);
      }
    });

    it('lists a courier the same way', async () => {
      seedAccount(COURIER_ID, 'courier');
      const COURIER_SESSION = id<'Session'>('01990000-0000-7000-8000-00000000b001');
      seedSession(COURIER_SESSION, COURIER_ID, 10, 0, 'samsung.android', 'courier');
      const result = await new ListOwnSessions(gate, deps()).execute(
        contextOf('courier', COURIER_ID, COURIER_SESSION),
        {},
      );
      expect(result.ok && result.value.items.map((item) => item.device)).toEqual([
        'samsung.android',
      ]);
    });

    it("refuses a merchant's API key", async () => {
      seedAccount(MERCHANT_ACCOUNT_ID, 'merchant');
      const result = await new ListOwnSessions(gate, deps()).execute(
        contextOf('merchant', MERCHANT_ACCOUNT_ID),
        {},
      );
      expect(result).toEqual({ ok: false, error: { code: 'access.denied' } });
    });
  });

  describe('SignOutOtherSessions', () => {
    it('ends every other session of the own account and keeps the current one', async () => {
      const result = await new SignOutOtherSessions(gate, deps()).execute(
        contextOf('admin', ADMIN_ID),
        {},
      );
      // The idle one is not revoked yet, so it is ended too: it could never be used again anyway.
      expect(result).toEqual({
        ok: true,
        value: { code: 'other-sessions-signed-out', revokedSessions: 3 },
      });
      expect(sessionOf(CURRENT).revokedAt).toBeNull();
      for (const ended of [LAPTOP, PHONE, IDLE]) {
        expect(sessionOf(ended).revokedReason).toBe('signed-out-elsewhere');
        expect(sessionOf(ended).revokedAt).toEqual(START);
      }
      // Already signed out: keeps its own reason.
      expect(sessionOf(SIGNED_OUT).revokedReason).toBe('sign-out');
      // Another account's session is never touched.
      expect(sessionOf(OTHER_ACCOUNTS).revokedAt).toBeNull();
    });

    it('records the action with the kept session and the count, nothing personal', async () => {
      await new SignOutOtherSessions(gate, deps()).execute(contextOf('admin', ADMIN_ID), {});
      const entries = fakes.audits.filter(
        (entry) => entry.action === 'identity.account.other-sessions-signed-out',
      );
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        targetId: ADMIN_ID,
        after: { keptSessionId: CURRENT, revokedSessions: 3 },
      });
    });

    it('answers 0 and still records when there is no other session', async () => {
      const first = new SignOutOtherSessions(gate, deps());
      await first.execute(contextOf('admin', ADMIN_ID), {});
      const again = await first.execute(contextOf('admin', ADMIN_ID), {});
      expect(again).toEqual({
        ok: true,
        value: { code: 'other-sessions-signed-out', revokedSessions: 0 },
      });
      expect(
        fakes.audits.filter((e) => e.action === 'identity.account.other-sessions-signed-out'),
      ).toHaveLength(2);
    });

    it('changes nothing when the current session was revoked meanwhile', async () => {
      await fakes.sessionRepository.revoke(market, CURRENT, ADMIN_ID, 'sign-out', START);
      const result = await new SignOutOtherSessions(gate, deps()).execute(
        contextOf('admin', ADMIN_ID),
        {},
      );
      expect(result).toEqual({ ok: false, error: { code: 'session.invalid' } });
      expect(sessionOf(LAPTOP).revokedAt).toBeNull();
      expect(fakes.audits).toHaveLength(0);
    });

    it('refuses a session that is not the account’s own', async () => {
      const result = await new SignOutOtherSessions(gate, deps()).execute(
        contextOf('admin', ADMIN_ID, OTHER_ACCOUNTS),
        {},
      );
      expect(result).toEqual({ ok: false, error: { code: 'session.invalid' } });
      expect(sessionOf(LAPTOP).revokedAt).toBeNull();
    });

    it('records the notice event once per call that ended a session, ids only', async () => {
      const useCase = new SignOutOtherSessions(gate, deps());
      await useCase.execute(contextOf('admin', ADMIN_ID), {});
      await useCase.execute(contextOf('admin', ADMIN_ID), {});
      // The second call ended nothing, so the holder is not told again.
      expect(signedOutEvents()).toHaveLength(1);
      expect(signedOutEvents()[0]).toMatchObject({
        aggregateType: 'account',
        aggregateId: ADMIN_ID,
        aggregateVersion: 4,
        occurredAt: START,
        payload: { accountId: ADMIN_ID },
      });
    });

    it('refuses above the Market limit with the wait, and changes nothing', async () => {
      const limit = policy.signOutOthersThrottle(market)!.limit;
      const useCase = new SignOutOtherSessions(gate, deps());
      for (let call = 0; call < limit; call += 1) {
        await expect(useCase.execute(contextOf('admin', ADMIN_ID), {})).resolves.toMatchObject({
          ok: true,
        });
      }
      seedSession(NEW_DEVICE, ADMIN_ID, 1, 0, 'safari.macos');
      const refused = await useCase.execute(contextOf('admin', ADMIN_ID), {});
      const windowMinutes = policy.signOutOthersThrottle(market)!.windowMinutes;
      expect(refused).toEqual({
        ok: false,
        error: { code: 'request.throttled', retryAfterSeconds: windowMinutes * 60 },
      });
      expect(sessionOf(NEW_DEVICE).revokedAt).toBeNull();
      expect(
        fakes.audits.filter((e) => e.action === 'identity.account.other-sessions-signed-out'),
      ).toHaveLength(limit);
      // Another account has its own counter.
      await expect(
        useCase.execute(contextOf('admin', OTHER_ADMIN_ID, OTHER_ACCOUNTS), {}),
      ).resolves.toMatchObject({ ok: true });
    });

    it('fails closed when the Market configures no limit', async () => {
      const unconfigured: IdentityMarketPolicy = Object.assign(
        Object.create(policy) as IdentityMarketPolicy,
        { signOutOthersThrottle: () => null },
      );
      const result = await new SignOutOtherSessions(gate, deps(undefined, unconfigured)).execute(
        contextOf('admin', ADMIN_ID),
        {},
      );
      expect(result).toEqual({ ok: false, error: { code: 'access.unavailable' } });
      expect(sessionOf(LAPTOP).revokedAt).toBeNull();
    });

    it("refuses a merchant's API key", async () => {
      seedAccount(MERCHANT_ACCOUNT_ID, 'merchant');
      const result = await new SignOutOtherSessions(gate, deps()).execute(
        contextOf('merchant', MERCHANT_ACCOUNT_ID),
        {},
      );
      expect(result).toEqual({ ok: false, error: { code: 'access.denied' } });
    });
  });

  describe('SendOtherSessionsSignedOutMail', () => {
    const system = testCallContext(market, 'system');
    const mailDeps = () => ({
      unitOfWork: fakes.unitOfWork,
      accounts: fakes.accountRepository,
      composer,
      transport: fakes.mailTransport,
      policy,
    });

    it.each(['admin', 'courier'] as const)(
      'tells the %s address when, with no link and no token',
      async (population) => {
        const accountId = population === 'admin' ? ADMIN_ID : COURIER_ID;
        if (population === 'courier') seedAccount(COURIER_ID, 'courier');
        const result = await new SendOtherSessionsSignedOutMail(gate, mailDeps()).execute(system, {
          delivery: deliveryOf(),
          accountId,
          occurredAt: START,
        });
        expect(result).toEqual({
          ok: true,
          value: { code: 'other-sessions-signed-out-mail.sent' },
        });
        const mail = fakes.mails.at(-1)!;
        expect(mail.to).toBe(`${accountId}@example.com`);
        expect(mail.text).not.toMatch(/https?:|{/);
      },
    );

    it('sends once per delivery and skips an account that is gone', async () => {
      const send = new SendOtherSessionsSignedOutMail(gate, mailDeps());
      const delivery = deliveryOf();
      await send.execute(system, { delivery, accountId: ADMIN_ID, occurredAt: START });
      await expect(
        send.execute(system, { delivery, accountId: ADMIN_ID, occurredAt: START }),
      ).resolves.toEqual({
        ok: true,
        value: { code: 'other-sessions-signed-out-mail.already-handled' },
      });
      await expect(
        send.execute(system, { delivery: deliveryOf(), accountId: MERCHANT_ACCOUNT_ID, occurredAt: START }),
      ).resolves.toEqual({
        ok: true,
        value: { code: 'other-sessions-signed-out-mail.skipped', reason: 'account.gone' },
      });
    });

    it('refuses any caller but the system', async () => {
      await expect(
        new SendOtherSessionsSignedOutMail(gate, mailDeps()).execute(contextOf('admin', ADMIN_ID), {
          delivery: deliveryOf(),
          accountId: ADMIN_ID,
          occurredAt: START,
        }),
      ).resolves.toEqual({ ok: false, error: { code: 'access.denied' } });
    });
  });
});
