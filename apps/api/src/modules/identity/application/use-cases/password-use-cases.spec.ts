import { createHash } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { parseId, Temporal } from '@mondapac-drive/shared-kernel';
import type { Id, PendingEvent, Population } from '@mondapac-drive/shared-kernel';
import {
  FixedClock,
  SequenceIdGenerator,
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
import type { AccountState } from '../../domain/account';
import type { SecondFactorState } from '../../domain/second-factor';
import { timeStepAt } from '../../domain/totp';
import { openSession } from '../../domain/session';
import { MarketConfigIdentityPolicy } from '../../infrastructure/market-config-identity-policy';
import { RandomLinkTokens } from '../../infrastructure/links/random-link-tokens';
import { CatalogueMailComposer, formatDuration } from '../../infrastructure/mail/mail-catalogue';
import { hotp } from '../../infrastructure/second-factor/totp';
import { RandomSessionTokens } from '../../infrastructure/sessions/random-session-tokens';
import type { ThrottleKeys } from '../ports/session-secrets';
import { ChangePassword } from './change-password.use-case';
import { RequestPasswordReset } from './request-password-reset.use-case';
import { ResetPassword } from './reset-password.use-case';
import { SendLinkMail } from './send-link-mail.use-case';
import { SendPasswordChangedMail } from './send-password-changed-mail.use-case';
import { SignInCustomer } from './sign-in-customer.use-case';

// Identity slice 4, in memory (identity design 3.5, 3.7, 6.2, 6.5, 6.6, 6.8, 9; SEL-05, ACC-04;
// AC 8, 13, 18, 19, 21, 32): the reset request, the reset mail, the reset with its link, the
// signed-in change and the "password changed" notice, for both Market fixtures (AU en-AU and the
// synthetic ZZ ja-JP, each with its own throttles, password rules and sessions) and both
// populations. The PostgreSQL behaviour, the credential lock against a racing sign-in (Hassan
// slice-2 N1) included, is in test/db/password-reset.db-spec.ts.

const START = Temporal.Instant.from('2026-10-08T10:00:00Z');
const OLD_PASSWORD = 'correct horse battery staple';
const NEW_PASSWORD = 'a completely different passphrase';
const ORIGIN = '203.0.113.7';
const CLIENT = { origin: ORIGIN, address: ORIGIN };
const id = <T extends string>(text: string): Id<T> => {
  const parsed = parseId(text);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const CUSTOMER_ID = id<'Account'>('01990000-0000-7000-8000-000000000001');
const SELLER_ACCOUNT_ID = id<'Account'>('01990000-0000-7000-8000-000000000002');
const SELLER_ID = id<'Seller'>('01990000-0000-7000-8000-0000000000f1');
const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const policy = new MarketConfigIdentityPolicy(markets);
const composer = new CatalogueMailComposer(markets, loadLocaleCatalogues(TEST_LOCALE_CONFIG_DIRS));
const allow: AuthorisationCheck = {
  check: (): Promise<AccessDecision> => Promise.resolve({ allowed: true }),
};
const keys: ThrottleKeys = {
  account: (market, population, email) => Buffer.from(`${market.marketId}|${population}|${email}`),
  accountOrigin: (market, population, email, origin) =>
    Buffer.from(`${market.marketId}|${population}|${email}|${origin}`),
  origin: (market, origin) => Buffer.from(`${market.marketId}|${origin}`),
};
const sessionTokens = new RandomSessionTokens();
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
/** The token in the fragment of a mailed link. */
const tokenOf = (text: string): string => /#(ml1_[A-Za-z0-9_-]{43})/.exec(text)![1]!;

let deliveries = 0;
function deliveryOf(subscriber: string): EventDelivery {
  deliveries += 1;
  return {
    eventId: `0199ffff-0000-7000-8000-${String(deliveries).padStart(12, '0')}` as Id<'event'>,
    subscriber,
    attempt: 1,
  };
}

describe.each(TEST_MARKETS)('password reset and change in market %s (identity slice 4)', (code) => {
  const market = testMarketContext(code, PLATFORM_TENANT_ID);
  const anonymous = testCallContext(market, 'anonymous', 'password-test-0001');
  const system = testCallContext(market, 'system', 'password-test-0002');
  const gate = createUseCaseGate(markets, allow);
  let fakes: IdentityFakes;
  let clock: FixedClock;
  let logs: jest.SpyInstance;

  beforeEach(() => {
    fakes = new IdentityFakes();
    clock = new FixedClock(START);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    logs = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  const email = (population: Population) =>
    population === 'customer'
      ? { typed: 'Me@Example.com', normalized: 'me@example.com' }
      : { typed: 'Shop@Example.com', normalized: 'shop@example.com' };
  const accountIdOf = (population: Population) =>
    population === 'customer' ? CUSTOMER_ID : SELLER_ACCOUNT_ID;

  function seed(population: 'customer' | 'seller', overrides: Partial<AccountState> = {}) {
    fakes.seedAccount({
      id: accountIdOf(population),
      marketId: market.marketId,
      population,
      email: email(population),
      displayName: population === 'customer' ? null : 'Amina Rahman',
      status: 'active',
      emailVerifiedAt: START.subtract({ hours: 48 }),
      existingAccountNoticeAt: null,
      signedUpAt: START.subtract({ hours: 49 }),
      createdAt: START.subtract({ hours: 49 }),
      version: 3,
      credential: { passwordHash: fakeHashOf(OLD_PASSWORD), changedAt: START },
      ...overrides,
    });
  }

  /** A live session of the account, with its token. */
  function sessionOf(population: 'customer' | 'seller', n: number, keepSignedIn = false) {
    const issued = sessionTokens.issue();
    const session = openSession({
      id: id<'Session'>(`01990000-0000-7000-8000-00000000a00${n}`),
      marketId: market.marketId,
      accountId: accountIdOf(population),
      population,
      sellerId: population === 'seller' ? SELLER_ID : null,
      transport: 'cookie',
      lifetime: policy.sessionLifetime(market, population, keepSignedIn)!,
      now: clock.now(),
    });
    void fakes.sessionRepository.add(market, session, issued.tokenHash);
    return { session, token: issued.token };
  }

  function useCases() {
    const ids = new SequenceIdGenerator(clock);
    const linkTokens = new RandomLinkTokens();
    const common = {
      unitOfWork: fakes.unitOfWork,
      accounts: fakes.accountRepository,
      throttles: fakes.throttleRepository,
      keys,
      outbox: fakes.outbox,
      policy,
      clock,
    };
    const commonPasswords = { isCommon: (p: string) => p === 'password1234567890' };
    return {
      request: new RequestPasswordReset(gate, { ...common, links: fakes.linkRepository, ids }),
      reset: new ResetPassword(gate, {
        ...common,
        links: fakes.linkRepository,
        sessions: fakes.sessionRepository,
        challenges: fakes.challengeRepository,
        factors: fakes.factorRepository,
        records: fakes.recordRepository,
        ids,
        linkTokens,
        hasher: fakes.hasher,
        commonPasswords,
      }),
      change: new ChangePassword(gate, {
        ...common,
        sessions: fakes.sessionRepository,
        challenges: fakes.challengeRepository,
        links: fakes.linkRepository,
        records: fakes.recordRepository,
        ids,
        tokens: sessionTokens,
        factors: fakes.factorRepository,
        secrets: fakes.secrets,
        hasher: fakes.hasher,
        commonPasswords,
      }),
      sendLinkMail: new SendLinkMail(gate, {
        unitOfWork: fakes.unitOfWork,
        accounts: fakes.accountRepository,
        links: fakes.linkRepository,
        linkTokens,
        targets: policy,
        composer,
        transport: fakes.mailTransport,
        policy,
        clock,
      }),
      sendChangedMail: new SendPasswordChangedMail(gate, {
        unitOfWork: fakes.unitOfWork,
        accounts: fakes.accountRepository,
        composer,
        transport: fakes.mailTransport,
        policy,
      }),
      signIn: new SignInCustomer(gate, {
        ...common,
        sessions: fakes.sessionRepository,
        records: fakes.recordRepository,
        hasher: fakes.hasher,
        tokens: sessionTokens,
        ids,
      }),
    };
  }
  type UseCases = ReturnType<typeof useCases>;

  const eventsOf = (type: string) => fakes.events.filter((e) => e.type === type);
  const linkRequests = () => eventsOf('identity.one-time-link-requested.v1');

  /** Requests a reset and delivers its mail, as the dispatcher would; answers the token. */
  async function mailedResetToken(u: UseCases, population: 'customer' | 'seller') {
    await expect(
      u.request.execute(anonymous, { population, email: email(population).typed, origin: ORIGIN }),
    ).resolves.toEqual({ ok: true, value: { code: 'password-reset.accepted' } });
    const event = linkRequests().at(-1)!;
    const payload = event.payload as { linkId: Id; accountId: Id; purpose: 'reset-password' };
    await expect(
      u.sendLinkMail.execute(system, {
        delivery: deliveryOf('identity.link-mail'),
        linkId: payload.linkId,
        accountId: payload.accountId,
        purpose: payload.purpose,
        aggregateVersion: event.aggregateVersion,
      }),
    ).resolves.toEqual({ ok: true, value: { code: 'link-mail.sent', issued: true } });
    return tokenOf(fakes.mails.at(-1)!.text);
  }

  it('declares the rules of the new use cases (5.2 and its allow-list)', () => {
    expect(RequestPasswordReset.access).toEqual({
      name: 'identity.request-password-reset',
      rule: { kind: 'anonymous' },
    });
    expect(ResetPassword.access).toEqual({
      name: 'identity.reset-password',
      rule: { kind: 'anonymous' },
    });
    expect(ChangePassword.access).toEqual({
      name: 'identity.change-password',
      rule: { kind: 'own-resources' },
      whenSellerNotApproved: 'allow',
    });
    expect(SendPasswordChangedMail.access).toEqual({
      name: 'identity.send-password-changed-mail',
      rule: { kind: 'system' },
    });
  });

  describe('RequestPasswordReset (3.7, 6.7, 6.8; AC 13, AC 21)', () => {
    it.each(['customer', 'seller'] as const)(
      'requests a reset link for a verified, active %s account and answers as for any address',
      async (population) => {
        seed(population);
        const u = useCases();

        await expect(
          u.request.execute(anonymous, {
            population,
            email: email(population).typed,
            origin: ORIGIN,
          }),
        ).resolves.toEqual({ ok: true, value: { code: 'password-reset.accepted' } });

        expect(linkRequests()).toEqual([
          expect.objectContaining({
            payload: expect.objectContaining({
              accountId: accountIdOf(population),
              purpose: 'reset-password',
            }) as unknown,
          }),
        ]);
      },
    );

    it.each([
      ['an unknown address', null],
      ['an unverified account', { emailVerifiedAt: null }],
      ['a disabled account', { status: 'disabled' as const }],
    ])('answers the same and requests nothing for %s', async (_case, overrides) => {
      if (overrides !== null) seed('customer', overrides);
      const u = useCases();

      await expect(
        u.request.execute(anonymous, {
          population: 'customer',
          email: 'Me@Example.com',
          origin: ORIGIN,
        }),
      ).resolves.toEqual({ ok: true, value: { code: 'password-reset.accepted' } });
      expect(linkRequests()).toEqual([]);
    });

    it('requests nothing for the other population of the same address (AC 3, AC 19)', async () => {
      seed('customer');
      const u = useCases();

      await u.request.execute(anonymous, {
        population: 'seller',
        email: 'Me@Example.com',
        origin: ORIGIN,
      });

      expect(linkRequests()).toEqual([]);
    });

    it('stops mailing above the mail counter of the address, with the same answer', async () => {
      seed('customer');
      const u = useCases();
      const limit = policy.mailThrottles(market).account.limit;

      for (let i = 0; i <= limit; i += 1) {
        await expect(
          u.request.execute(anonymous, {
            population: 'customer',
            email: 'Me@Example.com',
            origin: ORIGIN,
          }),
        ).resolves.toEqual({ ok: true, value: { code: 'password-reset.accepted' } });
      }

      expect(linkRequests()).toHaveLength(limit);
    });

    it('stays available while sign-in of the address is blocked (AC 13)', async () => {
      seed('customer');
      const u = useCases();
      for (let i = 0; i < 30; i += 1) {
        await u.signIn.execute(anonymous, {
          email: 'Me@Example.com',
          password: 'a wrong guess of the password',
          client: CLIENT,
        });
      }

      await u.request.execute(anonymous, {
        population: 'customer',
        email: 'Me@Example.com',
        origin: ORIGIN,
      });

      expect(linkRequests()).toHaveLength(1);
    });

    it('fails closed when the counters are unreachable, and refuses a malformed email', async () => {
      seed('customer');
      const u = useCases();
      fakes.throttlesDown = true;

      await expect(
        u.request.execute(anonymous, {
          population: 'customer',
          email: 'Me@Example.com',
          origin: ORIGIN,
        }),
      ).resolves.toEqual({ ok: false, error: { code: 'access.unavailable' } });
      await expect(
        u.request.execute(anonymous, { population: 'customer', email: 'nope', origin: ORIGIN }),
      ).resolves.toEqual({
        ok: false,
        error: { code: 'validation.failed', fields: [{ path: 'email', code: 'format' }] },
      });
      expect(linkRequests()).toEqual([]);
    });
  });

  describe('the reset mail (E8; 3.7, 6.6, 9)', () => {
    it.each(['customer', 'seller'] as const)(
      'goes to the %s address in the Market locale, with the reset page and 60 minutes',
      async (population) => {
        seed(population);
        const u = useCases();

        const token = await mailedResetToken(u, population);

        const mail = fakes.mails.at(-1)!;
        expect(mail.to).toBe(email(population).typed);
        expect(mail.text).toContain(formatDuration(markets.get(market.marketId).defaultLocale, 60));
        expect(mail.text).toContain(
          `${policy.target(market, population, 'reset-password')}#${token}`,
        );
        if (code === 'AU') {
          expect(mail.subject).toBe(`Reset the password for your MondaPac ${population} account`);
          expect(mail.text).toContain('The link works for 1 hour and only once.');
        }
        // Only the hash is stored (6.6).
        const link = [...fakes.links.values()].find((l) => l.purpose === 'reset-password')!;
        expect(Buffer.from(link.tokenHash!).toString('hex')).toBe(sha256(token));
        expect(link.expiresAt).toEqual(link.issuedAt!.add({ minutes: 60 }));
      },
    );

    it('is skipped for an account that became unverified meanwhile', async () => {
      seed('customer');
      const u = useCases();
      await u.request.execute(anonymous, {
        population: 'customer',
        email: 'Me@Example.com',
        origin: ORIGIN,
      });
      const event = linkRequests().at(-1)!;
      fakes.accounts.set(CUSTOMER_ID, {
        ...fakes.accounts.get(CUSTOMER_ID)!,
        emailVerifiedAt: null,
      });
      const payload = event.payload as { linkId: Id; accountId: Id };

      await expect(
        u.sendLinkMail.execute(system, {
          delivery: deliveryOf('identity.link-mail'),
          linkId: payload.linkId,
          accountId: payload.accountId,
          purpose: 'reset-password',
          aggregateVersion: event.aggregateVersion,
        }),
      ).resolves.toEqual({
        ok: true,
        value: { code: 'link-mail.skipped', reason: 'account.unverified' },
      });
      expect(fakes.mails).toEqual([]);
    });
  });

  /**
   * An open challenge of the account and one of another account, and a stored factor, so a test
   * sees what the closing unit voids (HF11; Hassan I2 (d)) and what it keeps (Hassan I2 (a)).
   */
  function openChallengesAndFactor(accountId: Id<'Account'>, other: Id<'Account'>): void {
    for (const [n, owner] of [
      [1, accountId],
      [2, other],
    ] as const) {
      fakes.challenges.set(`challenge-${n}`, {
        challenge: {
          id: id<'SignInChallenge'>(`01990000-0000-7000-8000-0000000c000${n}`),
          marketId: market.marketId,
          accountId: owner,
          purpose: 'second-factor',
          attempts: 0,
          credentialChangedAt: clock.now(),
          expiresAt: clock.now().add({ minutes: 5 }),
          consumedAt: null,
          createdAt: clock.now(),
        },
        tokenHash: `${n}`.repeat(64),
      });
    }
    const factor: SecondFactorState = {
      id: id<'SecondFactor'>('01990000-0000-7000-8000-0000000d0001'),
      marketId: market.marketId,
      accountId,
      state: 'active',
      secretCiphertext: 'ciphertext',
      pendingSecretCiphertext: null,
      lastAcceptedStep: null,
      activatedAt: clock.now(),
      lockedAt: null,
      createdAt: clock.now(),
      // An active factor holds all ten codes (data design 3.10).
      recoveryCodes: Array.from({ length: 10 }, (_, index) => ({
        position: index + 1,
        codeHash: new Uint8Array(32).fill(index + 1),
        usedAt: null,
      })),
      version: 1,
    };
    fakes.factors.set(accountId, factor);
  }
  /**
   * Gives the stored factor of the account a secret the test knows (the real sealing over the
   * fake subject keys) and answers a function for the code the app would show now.
   */
  async function knownSecretOf(accountId: Id<'Account'>): Promise<() => string> {
    await fakes.subjectKeyService.createKey(market, accountId);
    const secret = fakes.secrets.newSecret();
    const ciphertext = await fakes.secrets.seal(market, accountId, secret);
    fakes.factors.set(accountId, {
      ...fakes.factors.get(accountId)!,
      secretCiphertext: ciphertext,
    });
    return () => hotp(secret, timeStepAt(clock.now()));
  }
  const otherAccount = (population: 'customer' | 'seller') =>
    population === 'customer' ? SELLER_ACCOUNT_ID : CUSTOMER_ID;
  const openChallengeOwners = () =>
    [...fakes.challenges.values()].map((e) => e.challenge.accountId);

  describe('ResetPassword (3.5, 3.7; AC 8, AC 13, AC 18, AC 19)', () => {
    it.each(['customer', 'seller'] as const)(
      "for a %s: voids the account's open challenges and keeps its second factor (HF11; Hassan I2 (a), (d))",
      async (population) => {
        seed(population);
        const u = useCases();
        const token = await mailedResetToken(u, population);
        openChallengesAndFactor(accountIdOf(population), otherAccount(population));

        await expect(
          u.reset.execute(anonymous, { population, token, password: NEW_PASSWORD, client: CLIENT }),
        ).resolves.toEqual({ ok: true, value: { code: 'password-changed' } });

        expect(openChallengeOwners()).toEqual([otherAccount(population)]);
        expect(fakes.factors.get(accountIdOf(population))?.state).toBe('active');
        // No session is opened: the next sign-in still asks for the factor.
        expect(fakes.sessions.size).toBe(0);
      },
    );

    it.each(['customer', 'seller'] as const)(
      'replaces a %s password, revokes every session, clears the counters and needs a new sign-in',
      async (population) => {
        seed(population);
        const u = useCases();
        sessionOf(population, 1);
        sessionOf(population, 2);
        const token = await mailedResetToken(u, population);
        // A sign-in block of the address and its counters (AC 13): the reset clears them.
        const accountKey = keys.account(market, population, email(population).normalized);
        await fakes.throttleRepository.reserve(
          market,
          [
            {
              kind: 'sign-in.account',
              keyHash: accountKey,
              accountKey,
              rule: policy.signInThrottles(market).account,
            },
          ],
          clock.now(),
        );
        clock.advance(Temporal.Duration.from({ minutes: 59 }));

        await expect(
          u.reset.execute(anonymous, { population, token, password: NEW_PASSWORD, client: CLIENT }),
        ).resolves.toEqual({ ok: true, value: { code: 'password-changed' } });

        const stored = fakes.accounts.get(accountIdOf(population))!;
        expect(stored.credential).toEqual({
          passwordHash: fakeHashOf(NEW_PASSWORD),
          changedAt: clock.now(),
        });
        expect(
          [...fakes.sessions.values()].map((s) => [s.session.revokedReason, s.session.revokedAt]),
        ).toEqual([
          ['password-reset', clock.now()],
          ['password-reset', clock.now()],
        ]);
        // The sign-in counters of the address go; its mail budget stays (Mojtaba, slice 4).
        expect(
          [...fakes.throttles.values()].filter((t) => t.accountKey !== null).map((t) => t.kind),
        ).toEqual(['mail.account']);
        expect(fakes.credentialLocks).toEqual([accountIdOf(population)]);
        // A sign-in record keeps where the reset came from (10.2; Hassan L3).
        expect(fakes.records.filter((r) => r.outcome === 'password-reset')).toEqual([
          expect.objectContaining({
            marketId: market.marketId,
            population,
            accountId: accountIdOf(population),
            address: ORIGIN,
            sessionId: null,
            correlationId: anonymous.correlationId,
          }),
        ]);
        expect(eventsOf('identity.account-password-changed.v1')).toEqual([
          expect.objectContaining({
            aggregateId: accountIdOf(population),
            payload: { accountId: accountIdOf(population), cause: 'reset' },
          }),
        ]);
        // Used once (AC 19).
        await expect(
          u.reset.execute(anonymous, { population, token, password: NEW_PASSWORD, client: CLIENT }),
        ).resolves.toEqual({ ok: false, error: { code: 'link.rejected' } });
      },
    );

    it('lets the customer sign in with the new password only (AC 8)', async () => {
      seed('customer');
      const u = useCases();
      const token = await mailedResetToken(u, 'customer');

      await u.reset.execute(anonymous, {
        population: 'customer',
        token,
        password: NEW_PASSWORD,
        client: CLIENT,
      });

      await expect(
        u.signIn.execute(anonymous, {
          email: 'Me@Example.com',
          password: OLD_PASSWORD,
          client: CLIENT,
        }),
      ).resolves.toEqual({ ok: false, error: { code: 'credentials.invalid' } });
      await expect(
        u.signIn.execute(anonymous, {
          email: 'Me@Example.com',
          password: NEW_PASSWORD,
          client: CLIENT,
        }),
      ).resolves.toMatchObject({ ok: true, value: { code: 'signed-in' } });
    });

    it.each(['customer', 'seller'] as const)(
      'refuses a %s link at 60 minutes and changes nothing (SEL-05, ACC-04, AC 8)',
      async (population) => {
        seed(population);
        const u = useCases();
        const token = await mailedResetToken(u, population);
        clock.advance(Temporal.Duration.from({ minutes: 60 }));

        await expect(
          u.reset.execute(anonymous, {
            population,
            token,
            password: NEW_PASSWORD,
            client: CLIENT,
          }),
        ).resolves.toEqual({ ok: false, error: { code: 'link.rejected' } });
        expect(fakes.accounts.get(accountIdOf(population))!.credential.passwordHash).toBe(
          fakeHashOf(OLD_PASSWORD),
        );
        expect(fakes.hashed).toBe(0);
      },
    );

    it.each([
      ['disabled', { status: 'disabled' as const }],
      ['unverified', { emailVerifiedAt: null }],
    ])(
      'refuses an account %s between the reservation and the closing unit, and changes nothing (Sajad Q2)',
      async (_, change) => {
        seed('customer');
        const live = sessionOf('customer', 1);
        const base = useCases();
        const token = await mailedResetToken(base, 'customer');
        const linkBefore = [...fakes.links.values()].find((l) => l.purpose === 'reset-password')!;
        // The account changes while the new password is being hashed (after the reservation).
        const reset = new ResetPassword(gate, {
          unitOfWork: fakes.unitOfWork,
          accounts: fakes.accountRepository,
          links: fakes.linkRepository,
          sessions: fakes.sessionRepository,
          challenges: fakes.challengeRepository,
          factors: fakes.factorRepository,
          throttles: fakes.throttleRepository,
          records: fakes.recordRepository,
          keys,
          linkTokens: new RandomLinkTokens(),
          outbox: fakes.outbox,
          hasher: {
            hash: async (plain) => {
              fakes.accounts.set(CUSTOMER_ID, { ...fakes.accounts.get(CUSTOMER_ID)!, ...change });
              return fakes.hasher.hash(plain);
            },
            verify: (plain, stored) => fakes.hasher.verify(plain, stored),
          },
          commonPasswords: { isCommon: () => false },
          policy,
          clock,
          ids: new SequenceIdGenerator(clock),
        });

        await expect(
          reset.execute(anonymous, {
            population: 'customer',
            token,
            password: NEW_PASSWORD,
            client: CLIENT,
          }),
        ).resolves.toEqual({ ok: false, error: { code: 'link.rejected' } });
        expect(fakes.accounts.get(CUSTOMER_ID)!.credential.passwordHash).toBe(
          fakeHashOf(OLD_PASSWORD),
        );
        const linkAfter = fakes.links.get(linkBefore.id)!;
        expect(linkAfter.consumedAt).toBeNull();
        expect(linkAfter.version).toBe(linkBefore.version);
        expect(fakes.sessions.get(live.session.id)!.session.revokedAt).toBeNull();
        expect(eventsOf('identity.account-password-changed.v1')).toEqual([]);
        expect(fakes.records.filter((r) => r.outcome === 'password-reset')).toEqual([]);
      },
    );

    it('refuses a link on the other population, in another Market and after a newer request (AC 19)', async () => {
      seed('customer');
      const u = useCases();
      const token = await mailedResetToken(u, 'customer');
      const other = testMarketContext(code === 'AU' ? 'ZZ' : 'AU', PLATFORM_TENANT_ID);

      await expect(
        u.reset.execute(anonymous, {
          population: 'seller',
          token,
          password: NEW_PASSWORD,
          client: CLIENT,
        }),
      ).resolves.toEqual({ ok: false, error: { code: 'link.rejected' } });
      await expect(
        u.reset.execute(testCallContext(other, 'anonymous'), {
          population: 'customer',
          token,
          password: NEW_PASSWORD,
          client: CLIENT,
        }),
      ).resolves.toEqual({ ok: false, error: { code: 'link.rejected' } });
      await u.request.execute(anonymous, {
        population: 'customer',
        email: 'Me@Example.com',
        origin: ORIGIN,
      });
      await expect(
        u.reset.execute(anonymous, {
          population: 'customer',
          token,
          password: NEW_PASSWORD,
          client: CLIENT,
        }),
      ).resolves.toEqual({ ok: false, error: { code: 'link.rejected' } });
      expect(fakes.hashed).toBe(0);
    });

    it('refuses a malformed or unknown token without hashing, counted per origin', async () => {
      seed('customer');
      const u = useCases();

      for (const token of ['nope', `ml1_${'A'.repeat(43)}`]) {
        await expect(
          u.reset.execute(anonymous, {
            population: 'customer',
            token,
            password: NEW_PASSWORD,
            client: CLIENT,
          }),
        ).resolves.toEqual({ ok: false, error: { code: 'link.rejected' } });
      }
      expect(fakes.hashed).toBe(0);
      const origin = [...fakes.throttles.values()].find((t) => t.kind === 'sign-in.origin')!;
      expect(origin.attempts).toBe(2);
    });

    it('refuses a weak new password and leaves the link usable', async () => {
      seed('customer');
      const u = useCases();
      const token = await mailedResetToken(u, 'customer');

      for (const [password, rule] of [
        ['short', 'length'],
        ['password1234567890', 'common'],
      ] as const) {
        await expect(
          u.reset.execute(anonymous, { population: 'customer', token, password, client: CLIENT }),
        ).resolves.toEqual({ ok: false, error: { code: 'password.rejected', rule } });
      }
      await expect(
        u.reset.execute(anonymous, {
          population: 'customer',
          token,
          password: NEW_PASSWORD,
          client: CLIENT,
        }),
      ).resolves.toEqual({ ok: true, value: { code: 'password-changed' } });
    });

    it('answers request.busy when the hash queue is full, and the link stays usable', async () => {
      seed('customer');
      const u = useCases();
      const token = await mailedResetToken(u, 'customer');
      fakes.busy = true;

      await expect(
        u.reset.execute(anonymous, {
          population: 'customer',
          token,
          password: NEW_PASSWORD,
          client: CLIENT,
        }),
      ).resolves.toEqual({ ok: false, error: { code: 'request.busy', retryAfterSeconds: 1 } });
      fakes.busy = false;
      await expect(
        u.reset.execute(anonymous, {
          population: 'customer',
          token,
          password: NEW_PASSWORD,
          client: CLIENT,
        }),
      ).resolves.toEqual({ ok: true, value: { code: 'password-changed' } });
    });

    it('refuses a disabled account and leaves the link unused', async () => {
      seed('customer');
      const u = useCases();
      const token = await mailedResetToken(u, 'customer');
      fakes.accounts.set(CUSTOMER_ID, { ...fakes.accounts.get(CUSTOMER_ID)!, status: 'disabled' });

      await expect(
        u.reset.execute(anonymous, {
          population: 'customer',
          token,
          password: NEW_PASSWORD,
          client: CLIENT,
        }),
      ).resolves.toEqual({ ok: false, error: { code: 'link.rejected' } });
      const link = [...fakes.links.values()].find((l) => l.purpose === 'reset-password')!;
      expect(link.consumedAt).toBeNull();
    });

    it('fails closed when the counters are unreachable', async () => {
      seed('customer');
      const u = useCases();
      const token = await mailedResetToken(u, 'customer');
      fakes.throttlesDown = true;

      await expect(
        u.reset.execute(anonymous, {
          population: 'customer',
          token,
          password: NEW_PASSWORD,
          client: CLIENT,
        }),
      ).resolves.toEqual({ ok: false, error: { code: 'access.unavailable' } });
      expect(fakes.hashed).toBe(0);
    });

    it('never logs the token or a password', async () => {
      seed('customer');
      const u = useCases();
      const token = await mailedResetToken(u, 'customer');

      await u.reset.execute(anonymous, {
        population: 'customer',
        token,
        password: NEW_PASSWORD,
        client: CLIENT,
      });

      const logged = JSON.stringify(logs.mock.calls);
      expect(logged).not.toContain(token);
      expect(logged).not.toContain(NEW_PASSWORD);
      expect(logged).not.toContain('me@example.com');
    });
  });

  describe('ChangePassword (3.5, 6.2, 6.5; AC 18, AC 32)', () => {
    const actorOf = (population: 'customer' | 'seller', sessionId: Id<'Session'>) =>
      testAuthenticatedActor(market, {
        population,
        accountId: accountIdOf(population),
        sessionId,
        sellerId: population === 'seller' ? SELLER_ID : null,
      });

    it.each(['customer', 'seller'] as const)(
      'for a %s: rotates the current session, revokes the others and records the change',
      async (population) => {
        seed(population);
        const u = useCases();
        const current = sessionOf(population, 1);
        sessionOf(population, 2);
        sessionOf(population, 3);
        const context = testCallContext(market, actorOf(population, current.session.id));

        const result = await u.change.execute(context, {
          currentPassword: OLD_PASSWORD,
          newPassword: NEW_PASSWORD,
          client: CLIENT,
        });

        expect(result).toMatchObject({ ok: true, value: { code: 'password-changed' } });
        const token = result.ok ? result.value.token : '';
        expect(token).not.toBe(current.token);
        const rows = [...fakes.sessions.values()];
        expect(rows.map((s) => s.session.revokedReason)).toEqual([
          null,
          'password-changed',
          'password-changed',
        ]);
        expect(rows[0]!.tokenHash).toBe(Buffer.from(sessionTokens.hashOf(token)!).toString('hex'));
        expect(fakes.accounts.get(accountIdOf(population))!.credential.passwordHash).toBe(
          fakeHashOf(NEW_PASSWORD),
        );
        expect(fakes.credentialLocks).toEqual([accountIdOf(population)]);
        expect(eventsOf('identity.account-password-changed.v1')).toEqual([
          expect.objectContaining({
            payload: { accountId: accountIdOf(population), cause: 'change' },
          }),
        ]);
        // The cookie: a customer's outlives the browser until the absolute expiry; a seller's
        // default session is a browser-session cookie (6.1).
        const lifetime = policy.sessionLifetime(market, population)!.absoluteLifetimeSeconds;
        expect(result.ok && result.value.cookieMaxAgeSeconds).toBe(
          population === 'customer' ? lifetime : null,
        );
        // The counters of the attempt are given back.
        expect(
          [...fakes.throttles.values()]
            .filter((t) => t.kind.startsWith('sign-in.'))
            .map((t) => t.attempts),
        ).toEqual([0, 0, 0]);
      },
    );

    it.each(['customer', 'seller'] as const)(
      'for a %s: cancels a reset link requested before the change (Hassan L2)',
      async (population) => {
        seed(population);
        const u = useCases();
        const token = await mailedResetToken(u, population);
        const current = sessionOf(population, 1);

        await expect(
          u.change.execute(testCallContext(market, actorOf(population, current.session.id)), {
            currentPassword: OLD_PASSWORD,
            newPassword: NEW_PASSWORD,
            client: CLIENT,
          }),
        ).resolves.toMatchObject({ ok: true });
        await expect(
          u.reset.execute(anonymous, {
            population,
            token,
            password: 'yet another long passphrase',
            client: CLIENT,
          }),
        ).resolves.toEqual({ ok: false, error: { code: 'link.rejected' } });
        expect(fakes.accounts.get(accountIdOf(population))!.credential.passwordHash).toBe(
          fakeHashOf(NEW_PASSWORD),
        );
      },
    );

    it.each(['customer', 'seller'] as const)(
      "for a %s: voids the account's open challenges and keeps its second factor (HF11; Hassan I2 (d))",
      async (population) => {
        seed(population);
        const u = useCases();
        const current = sessionOf(population, 1);
        openChallengesAndFactor(accountIdOf(population), otherAccount(population));
        // A seller-side member with an active factor presents a code (profile package).
        const codeNow =
          population === 'seller' ? await knownSecretOf(accountIdOf(population)) : () => undefined;

        await expect(
          u.change.execute(testCallContext(market, actorOf(population, current.session.id)), {
            currentPassword: OLD_PASSWORD,
            newPassword: NEW_PASSWORD,
            ...(population === 'seller' ? { code: codeNow() } : {}),
            client: CLIENT,
          }),
        ).resolves.toMatchObject({ ok: true });

        expect(openChallengeOwners()).toEqual([otherAccount(population)]);
        expect(fakes.factors.get(accountIdOf(population))?.state).toBe('active');
      },
    );

    describe('a seller-side member with an active two-step sign-in (profile package)', () => {
      const change = (u: UseCases, sessionId: Id<'Session'>, extra: { code?: string } = {}) =>
        u.change.execute(testCallContext(market, actorOf('seller', sessionId)), {
          currentPassword: OLD_PASSWORD,
          newPassword: NEW_PASSWORD,
          ...extra,
          client: CLIENT,
        });
      const stillOld = () =>
        expect(fakes.accounts.get(SELLER_ACCOUNT_ID)!.credential.passwordHash).toBe(
          fakeHashOf(OLD_PASSWORD),
        );

      it('needs a code: without one nothing changes and the sign-in counters are given back', async () => {
        seed('seller');
        const u = useCases();
        const current = sessionOf('seller', 1);
        openChallengesAndFactor(SELLER_ACCOUNT_ID, CUSTOMER_ID);

        await expect(change(u, current.session.id)).resolves.toEqual({
          ok: false,
          error: { code: 'validation.failed', fields: [{ path: 'code', code: 'required' }] },
        });
        await expect(change(u, current.session.id, { code: 'not a code' })).resolves.toEqual({
          ok: false,
          error: { code: 'validation.failed', fields: [{ path: 'code', code: 'required' }] },
        });

        stillOld();
        expect(eventsOf('identity.account-password-changed.v1')).toEqual([]);
        expect(fakes.records).toEqual([]);
      });

      it('is repeated when a factor became active after the call began (no skipped code)', async () => {
        seed('seller');
        const u = useCases();
        const current = sessionOf('seller', 1);
        openChallengesAndFactor(SELLER_ACCOUNT_ID, CUSTOMER_ID);
        // The first read (when the call is admitted) sees no factor; the closing unit sees it.
        jest.spyOn(fakes.factorRepository, 'findByAccount').mockResolvedValueOnce(null);

        await expect(change(u, current.session.id)).resolves.toEqual({
          ok: false,
          error: { code: 'access.unavailable' },
        });

        stillOld();
        expect(eventsOf('identity.account-password-changed.v1')).toEqual([]);
      });

      it('refuses a wrong code, counts it and changes nothing', async () => {
        seed('seller');
        const u = useCases();
        const current = sessionOf('seller', 1);
        openChallengesAndFactor(SELLER_ACCOUNT_ID, CUSTOMER_ID);
        const codeNow = await knownSecretOf(SELLER_ACCOUNT_ID);
        const wrong = codeNow() === '000000' ? '000001' : '000000';

        await expect(change(u, current.session.id, { code: wrong })).resolves.toEqual({
          ok: false,
          error: { code: 'second-factor.invalid' },
        });

        stillOld();
        expect(fakes.records.map((r) => r.outcome)).toEqual(['second-factor.invalid']);
      });

      it('accepts the right code once and refuses the same code again', async () => {
        seed('seller');
        const u = useCases();
        const current = sessionOf('seller', 1);
        openChallengesAndFactor(SELLER_ACCOUNT_ID, CUSTOMER_ID);
        const codeNow = await knownSecretOf(SELLER_ACCOUNT_ID);
        const code = codeNow();

        await expect(change(u, current.session.id, { code })).resolves.toMatchObject({ ok: true });
        expect(fakes.accounts.get(SELLER_ACCOUNT_ID)!.credential.passwordHash).toBe(
          fakeHashOf(NEW_PASSWORD),
        );
        // The same step was spent: a replayed code is refused, whatever the password.
        await expect(change(u, current.session.id, { code })).resolves.toMatchObject({ ok: false });
      });

      it('asks for no code when the member has no active factor, and ignores one sent anyway', async () => {
        seed('seller');
        const u = useCases();
        const current = sessionOf('seller', 1);

        await expect(change(u, current.session.id, { code: 'whatever' })).resolves.toMatchObject({
          ok: true,
        });
      });
    });

    it('records a wrong current password and the change, with session, address and correlation id (Hassan L3)', async () => {
      seed('customer');
      const u = useCases();
      const current = sessionOf('customer', 1);
      const context = testCallContext(
        market,
        actorOf('customer', current.session.id),
        'password-change-0001',
      );

      await u.change.execute(context, {
        currentPassword: 'not the password',
        newPassword: NEW_PASSWORD,
        client: CLIENT,
      });
      await u.change.execute(context, {
        currentPassword: OLD_PASSWORD,
        newPassword: NEW_PASSWORD,
        client: CLIENT,
      });

      const expected = (outcome: string) =>
        expect.objectContaining({
          marketId: market.marketId,
          population: 'customer',
          accountId: CUSTOMER_ID,
          outcome,
          address: ORIGIN,
          sessionId: current.session.id,
          correlationId: 'password-change-0001',
        }) as unknown;
      expect(fakes.records).toEqual([
        expected('password.current-incorrect'),
        expected('password-changed'),
      ]);
    });

    it('keeps a seller\'s "keep me signed in" cookie persistent, for what is left of it', async () => {
      seed('seller');
      const u = useCases();
      const current = sessionOf('seller', 1, true);
      clock.advance(Temporal.Duration.from({ hours: 2 }));

      const result = await u.change.execute(
        testCallContext(market, actorOf('seller', current.session.id)),
        { currentPassword: OLD_PASSWORD, newPassword: NEW_PASSWORD, client: CLIENT },
      );

      const kept = policy.sessionLifetime(market, 'seller', true)!.absoluteLifetimeSeconds;
      expect(result.ok && result.value.cookieMaxAgeSeconds).toBe(kept - 2 * 3600);
    });

    it('refuses a wrong current password, counts it, and throttles further guesses', async () => {
      seed('customer');
      const u = useCases();
      const current = sessionOf('customer', 1);
      const context = testCallContext(market, actorOf('customer', current.session.id));
      const limit = policy.signInThrottles(market).accountOrigin.limit;

      for (let i = 0; i < limit; i += 1) {
        await expect(
          u.change.execute(context, {
            currentPassword: `wrong guess number ${i}`,
            newPassword: NEW_PASSWORD,
            client: CLIENT,
          }),
        ).resolves.toEqual({ ok: false, error: { code: 'password.current-incorrect' } });
      }
      const verified = fakes.verified;
      await expect(
        u.change.execute(context, {
          currentPassword: OLD_PASSWORD,
          newPassword: NEW_PASSWORD,
          client: CLIENT,
        }),
      ).resolves.toMatchObject({ ok: false, error: { code: 'request.throttled' } });
      // HF1: a throttled attempt is refused before any hash.
      expect(fakes.verified).toBe(verified);
      expect(fakes.accounts.get(CUSTOMER_ID)!.credential.passwordHash).toBe(
        fakeHashOf(OLD_PASSWORD),
      );
      expect(fakes.sessions.get(current.session.id)!.session.revokedAt).toBeNull();
    });

    it('checks the new password before verifying the current one', async () => {
      seed('seller');
      const u = useCases();
      const current = sessionOf('seller', 1);

      await expect(
        u.change.execute(testCallContext(market, actorOf('seller', current.session.id)), {
          currentPassword: OLD_PASSWORD,
          newPassword: 'Amina Rahman',
          client: CLIENT,
        }),
      ).resolves.toEqual({ ok: false, error: { code: 'password.rejected', rule: 'length' } });
      expect(fakes.verified).toBe(0);
    });

    it('refuses when the current session was revoked meanwhile, and changes nothing', async () => {
      seed('customer');
      const u = useCases();
      const current = sessionOf('customer', 1);
      await fakes.sessionRepository.revoke(
        market,
        current.session.id,
        CUSTOMER_ID,
        'sign-out',
        clock.now(),
      );

      await expect(
        u.change.execute(testCallContext(market, actorOf('customer', current.session.id)), {
          currentPassword: OLD_PASSWORD,
          newPassword: NEW_PASSWORD,
          client: CLIENT,
        }),
      ).resolves.toEqual({ ok: false, error: { code: 'session.invalid' } });
      expect(fakes.accounts.get(CUSTOMER_ID)!.credential.passwordHash).toBe(
        fakeHashOf(OLD_PASSWORD),
      );
      expect(eventsOf('identity.account-password-changed.v1')).toEqual([]);
    });

    it('refuses the anonymous actor (gate) and an admin until the second factor exists', async () => {
      const u = useCases();
      await expect(
        u.change.execute(anonymous, {
          currentPassword: OLD_PASSWORD,
          newPassword: NEW_PASSWORD,
          client: CLIENT,
        }),
      ).resolves.toEqual({ ok: false, error: { code: 'access.unauthenticated' } });
      const admin = testAuthenticatedActor(market, {
        population: 'admin',
        accountId: CUSTOMER_ID,
        sessionId: id<'Session'>('01990000-0000-7000-8000-00000000a009'),
        sellerId: null,
      });
      // An admin's change always carries a code (Hassan I2 (b)): without one it is refused as input.
      await expect(
        u.change.execute(testCallContext(market, admin), {
          currentPassword: OLD_PASSWORD,
          newPassword: NEW_PASSWORD,
          client: CLIENT,
        }),
      ).resolves.toEqual({
        ok: false,
        error: { code: 'validation.failed', fields: [{ path: 'code', code: 'format' }] },
      });
      // With a code but no active factor, the admin is refused before any password is compared.
      seed('customer');
      await expect(
        u.change.execute(testCallContext(market, admin), {
          currentPassword: OLD_PASSWORD,
          newPassword: NEW_PASSWORD,
          code: '123456',
          client: CLIENT,
        }),
      ).resolves.toEqual({ ok: false, error: { code: 'access.denied' } });
    });

    it('fails closed when the counters are unreachable', async () => {
      seed('customer');
      const u = useCases();
      const current = sessionOf('customer', 1);
      fakes.throttlesDown = true;

      await expect(
        u.change.execute(testCallContext(market, actorOf('customer', current.session.id)), {
          currentPassword: OLD_PASSWORD,
          newPassword: NEW_PASSWORD,
          client: CLIENT,
        }),
      ).resolves.toEqual({ ok: false, error: { code: 'access.unavailable' } });
      expect(fakes.verified).toBe(0);
    });
  });

  describe('the "password changed" notice (E13; 9)', () => {
    async function deliver(u: UseCases, event: PendingEvent) {
      const payload = event.payload as { accountId: Id; cause: 'reset' | 'change' };
      return u.sendChangedMail.execute(system, {
        delivery: deliveryOf('identity.password-changed-mail'),
        accountId: payload.accountId,
        cause: payload.cause,
        occurredAt: event.occurredAt,
      });
    }

    it.each(['customer', 'seller'] as const)(
      'tells the %s address when, with no link and no token',
      async (population) => {
        seed(population);
        const u = useCases();
        const current = sessionOf(population, 1);
        await u.change.execute(
          testCallContext(
            market,
            testAuthenticatedActor(market, {
              population,
              accountId: accountIdOf(population),
              sessionId: current.session.id,
              sellerId: population === 'seller' ? SELLER_ID : null,
            }),
          ),
          { currentPassword: OLD_PASSWORD, newPassword: NEW_PASSWORD, client: CLIENT },
        );

        await expect(
          deliver(u, eventsOf('identity.account-password-changed.v1')[0]!),
        ).resolves.toEqual({ ok: true, value: { code: 'password-changed-mail.sent' } });

        const mail = fakes.mails.at(-1)!;
        expect(mail.to).toBe(email(population).typed);
        expect(mail.text).not.toMatch(/https?:|ml1_|\{[a-z]+\}/);
        if (code === 'AU') {
          expect(mail.subject).toBe(
            `The password for your MondaPac ${population} account was changed`,
          );
          expect(mail.text).toContain(
            "If this wasn't you, reset your password from the sign-in page straight away.",
          );
          // 10:00 UTC is 20:00 in Brisbane (the Market's zone, ADR-0005 fallback).
          expect(mail.text).toContain('8 October 2026');
          expect(mail.text).toMatch(/8:00:00\s?pm/);
        } else {
          // 10:00 UTC is 19:00 in Tokyo.
          expect(mail.text).toContain('2026年10月8日');
          expect(mail.text).toContain('19:00:00');
        }
      },
    );

    it('skips an account that is gone', async () => {
      seed('customer');
      const u = useCases();
      const event = {
        type: 'identity.account-password-changed.v1',
        aggregateId: CUSTOMER_ID,
        aggregateVersion: 4,
        occurredAt: START,
        payload: { accountId: CUSTOMER_ID, cause: 'reset' },
      } as unknown as PendingEvent;
      fakes.accounts.delete(CUSTOMER_ID);

      await expect(deliver(u, event)).resolves.toEqual({
        ok: true,
        value: { code: 'password-changed-mail.skipped', reason: 'account.gone' },
      });
      expect(fakes.mails).toEqual([]);
    });
  });
});
