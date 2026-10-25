import { createHash } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { parseId, Temporal } from '@mondapac-drive/shared-kernel';
import type { Id, MarketContext, Result } from '@mondapac-drive/shared-kernel';
import {
  FixedClock,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac-drive/shared-kernel/testing';
import { fakeHashOf, IdentityFakes } from '../../../../../test/support/identity-fakes';
import {
  realEffectiveKeys,
  realPermissionRegistry,
} from '../../../../../test/support/permission-registry';
import {
  TEST_MARKET_CONFIG_DIRS,
  TEST_MARKET_IDS,
  TEST_MARKETS,
} from '../../../../../test/support/test-config';
import type { AccessDecision, AuthorisationCheck } from '../../../../platform/authz';
import { createUseCaseGate } from '../../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import { PLATFORM_TENANT_ID } from '../../../../platform/market-context/tenant';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { openSession } from '../../domain/session';
import { MarketConfigIdentityPolicy } from '../../infrastructure/market-config-identity-policy';
import { IdentityFacadeImplementation } from '../../presentation/identity.facade';
import { DescribeActor } from './describe-actor.use-case';
import {
  LINK_KEPT_AFTER_SPENT_HOURS,
  MAX_RECORD_DAYS_PER_RUN,
  INVITATION_KEPT_AFTER_DECISION_HOURS,
  PurgeExpired,
  SESSION_KEPT_AFTER_EXPIRY_HOURS,
  THROTTLE_KEPT_HOURS,
} from './purge-expired.use-case';
import { SignOut } from './sign-out.use-case';

// Sign-out, the actor summary and its facade, and identity.purge-expired (identity design 3.5,
// 8.1, 8.6, 12.2; data design 3.4 to 3.6, 9), for both Market fixtures.

const START = Temporal.Instant.from('2026-10-08T10:00:00Z');
const id = <T extends string>(text: string): Id<T> => {
  const parsed = parseId(text);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const ACCOUNT_ID = id<'Account'>('01990000-0000-7000-8000-000000000001');
const SESSION_ID = id<'Session'>('01990000-0000-7000-8000-00000000a001');
const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const policy = new MarketConfigIdentityPolicy(markets);
const allow: AuthorisationCheck = {
  check: (): Promise<AccessDecision> => Promise.resolve({ allowed: true }),
};

describe.each(TEST_MARKETS)('session use cases in market %s', (code) => {
  const market = testMarketContext(code, PLATFORM_TENANT_ID);
  const actor = testAuthenticatedActor(market, {
    population: 'courier',
    accountId: ACCOUNT_ID,
    sessionId: SESSION_ID,
    merchantId: null,
  });
  const context = testCallContext(market, actor);
  const gate = createUseCaseGate(markets, allow);
  let fakes: IdentityFakes;
  let clock: FixedClock;
  let warnings: jest.SpyInstance;

  beforeEach(() => {
    fakes = new IdentityFakes();
    clock = new FixedClock(START);
    warnings = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    fakes.seedAccount({
      id: ACCOUNT_ID,
      marketId: market.marketId,
      population: 'courier',
      email: { typed: 'Me@Example.com', normalized: 'me@example.com' },
      displayName: 'Amina Rahman',
      timezone: null,
      locale: null,
      status: 'active',
      emailVerifiedAt: START,
      signedUpAt: START,
      createdAt: START,
      version: 1,
      credential: { passwordHash: fakeHashOf('x'), changedAt: START },
    });
    void fakes.sessionRepository.add(
      market,
      openSession({
        id: SESSION_ID,
        marketId: market.marketId,
        accountId: ACCOUNT_ID,
        population: 'courier',
        transport: 'bearer',
        lifetime: policy.sessionLifetime(market, 'courier')!,
        now: START,
      }),
      new Uint8Array(createHash('sha256').update('token').digest()),
    );
  });
  afterEach(() => warnings.mockRestore());

  describe('SignOut', () => {
    const signOut = () =>
      new SignOut(gate, { unitOfWork: fakes.unitOfWork, sessions: fakes.sessionRepository, clock });

    it('declares own-resources', () => {
      expect(SignOut.access).toEqual({
        name: 'identity.sign-out',
        rule: { kind: 'own-resources' },
      });
    });

    it("revokes the actor's own session with the reason sign-out; twice answers the same", async () => {
      await expect(signOut().execute(context, {})).resolves.toEqual({
        ok: true,
        value: { code: 'signed-out' },
      });
      expect(fakes.sessions.get(SESSION_ID)!.session).toMatchObject({
        revokedAt: START,
        revokedReason: 'sign-out',
      });
      await expect(signOut().execute(context, {})).resolves.toMatchObject({ ok: true });
    });

    it('is refused to an anonymous caller with access.unauthenticated', async () => {
      await expect(signOut().execute(testCallContext(market, 'anonymous'), {})).resolves.toEqual({
        ok: false,
        error: { code: 'access.unauthenticated' },
      });
    });
  });

  describe('DescribeActor and the facade', () => {
    const describeActor = () =>
      new DescribeActor(gate, {
        unitOfWork: fakes.unitOfWork,
        accounts: fakes.accountRepository,
        sessions: fakes.sessionRepository,
        merchants: fakes.merchantRepository,
        grants: fakes.grantReader,
        effectiveKeys: realEffectiveKeys(),
        factors: fakes.factorRepository,
        records: fakes.recordRepository,
      });
    // Only describeActor is called here; the other methods have their own suites.
    const facadeOf = (describe: DescribeActor) =>
      new IdentityFacadeImplementation({
        describeActor: describe,
        contactEmailOf: undefined as never,
        isActiveCourier: undefined as never,
        liveSessionsOf: undefined as never,
      });

    it("answers the actor's ids, email and session times; the facade drops the email", async () => {
      const lifetime = policy.sessionLifetime(market, 'courier')!;
      const summary = await describeActor().execute(context, {});

      expect(summary).toEqual({
        ok: true,
        value: {
          accountId: ACCOUNT_ID,
          population: 'courier',
          merchantId: null,
          roleId: null,
          permissionKeys: [],
          merchantState: null,
          secondFactorActive: false,
          lastSignInAt: null,
          email: 'Me@Example.com',
          displayName: 'Amina Rahman',
          timezone: null,
          locale: null,
          session: {
            idleTimeoutSeconds: lifetime.idleTimeoutSeconds,
            absoluteExpiresAt: START.add({ seconds: lifetime.absoluteLifetimeSeconds }).toString(),
          },
        },
      });
      const facade = await facadeOf(describeActor()).describeActor(context);
      expect(facade).toEqual({
        ok: true,
        value: {
          accountId: ACCOUNT_ID,
          population: 'courier',
          merchantId: null,
          roleId: null,
          permissionKeys: [],
          merchantState: null,
          secondFactorActive: false,
        },
      });
      expect(JSON.stringify(facade)).not.toContain('Example.com');
    });

    it('answers the previous successful sign-in, not the one that opened this session', async () => {
      const record = (sessionId: Id<'Session'> | null, outcome: string, at: Temporal.Instant) =>
        fakes.recordRepository.add(market, {
          id: id<'SignInRecord'>(
            `01990000-0000-7000-8000-0000000b${String(fakes.records.length).padStart(4, '0')}`,
          ),
          population: 'courier',
          accountId: ACCOUNT_ID,
          outcome,
          occurredAt: at,
          address: '203.0.113.9',
          sessionId,
          correlationId: 'correlation-1',
        });
      const OLDER = id<'Session'>('01990000-0000-7000-8000-00000000a002');
      await record(OLDER, 'signed-in', START.subtract({ hours: 30 }));
      await record(null, 'credentials.invalid', START.subtract({ hours: 2 }));
      await record(SESSION_ID, 'signed-in', START);

      const summary = await describeActor().execute(context, {});

      expect(summary).toMatchObject({
        ok: true,
        value: { lastSignInAt: START.subtract({ hours: 30 }).toString() },
      });
      expect(JSON.stringify(summary)).not.toContain('203.0.113.9');
    });

    describe('the effective keys of an admin fixture account (slice 8a-1; Sajad G1)', () => {
      const ADMIN_ID = id<'Account'>('01990000-0000-7000-8000-000000000a01');
      const ADMIN_SESSION = id<'Session'>('01990000-0000-7000-8000-00000000aa01');
      const ROLE_ID = id<'Role'>('01990000-0000-7000-8000-00000000d0a1');
      const adminContext = testCallContext(
        market,
        testAuthenticatedActor(market, {
          population: 'admin',
          accountId: ADMIN_ID,
          sessionId: ADMIN_SESSION,
          merchantId: null,
        }),
      );

      /** An admin account with one role, as test fixtures (no seed or route creates one). */
      function adminWith(role: {
        scope: 'platform' | 'courier';
        kind: 'system' | 'default' | 'custom';
        keys: string[];
      }) {
        fakes.seedAccount({
          id: ADMIN_ID,
          marketId: market.marketId,
          population: 'admin',
          email: { typed: 'Admin@Example.com', normalized: 'admin@example.com' },
          displayName: 'Admin',
          timezone: null,
          locale: null,
          status: 'active',
          emailVerifiedAt: START,
          signedUpAt: START,
          createdAt: START,
          version: 1,
          credential: { passwordHash: fakeHashOf('x'), changedAt: START },
        });
        void fakes.sessionRepository.add(
          market,
          openSession({
            id: ADMIN_SESSION,
            marketId: market.marketId,
            accountId: ADMIN_ID,
            population: 'admin',
            transport: 'cookie',
            lifetime: { idleTimeoutSeconds: 900, absoluteLifetimeSeconds: 28_800 },
            now: START,
          }),
          new Uint8Array(createHash('sha256').update('admin-token').digest()),
        );
        const seeded = role.kind !== 'custom';
        fakes.seedRole({
          id: ROLE_ID,
          marketId: market.marketId,
          scope: role.scope,
          kind: role.kind,
          seedCode: seeded ? 'fixture-role' : null,
          seedVersion: seeded ? 1 : null,
          permissionKeys: role.kind === 'system' ? [] : [...role.keys].sort(),
          version: 1,
          createdAt: START,
        });
        fakes.seedAssignment({
          id: id<'RoleAssignment'>('01990000-0000-7000-8000-00000000e0a1'),
          marketId: market.marketId,
          accountId: ADMIN_ID,
          roleId: ROLE_ID,
          assignedByAccountId: null,
          assignedAt: START,
          version: 1,
        });
      }

      const summaryOf = async () => {
        const result = await describeActor().execute(adminContext, {});
        if (!result.ok) throw new Error(`describeActor refused: ${result.error.code}`);
        return result.value;
      };

      it('a default role (Dispatcher) answers its keys, sorted, and its role id', async () => {
        adminWith({
          scope: 'platform',
          kind: 'default',
          keys: [
            'identity.courier-account.view',
            'identity.courier-account.invite',
            'delivery.delivery.view',
            'delivery.delivery.dispatch',
          ],
        });

        await expect(summaryOf()).resolves.toMatchObject({
          roleId: ROLE_ID,
          permissionKeys: [
            'delivery.delivery.dispatch',
            'delivery.delivery.view',
            'identity.courier-account.invite',
            'identity.courier-account.view',
          ],
        });
      });

      it('the Platform Administrator answers every platform key the registry declares', async () => {
        adminWith({ scope: 'platform', kind: 'system', keys: [] });

        expect((await summaryOf()).permissionKeys).toEqual(
          realPermissionRegistry()
            .list('platform')
            .map((d) => d.key)
            .sort(),
        );
      });

      it('a custom role drops a stored key the registry no longer declares (R7)', async () => {
        adminWith({
          scope: 'platform',
          kind: 'custom',
          keys: ['identity.merchant.view', 'identity.ledger.view'],
        });

        expect((await summaryOf()).permissionKeys).toEqual(['identity.merchant.view']);
      });

      it('a courier-scope role on an admin account grants nothing', async () => {
        adminWith({ scope: 'courier', kind: 'system', keys: [] });

        await expect(summaryOf()).resolves.toMatchObject({ roleId: ROLE_ID, permissionKeys: [] });
      });
    });

    it('is refused to an anonymous caller through the facade too (the gate runs)', async () => {
      await expect(
        facadeOf(describeActor()).describeActor(testCallContext(market, 'anonymous')),
      ).resolves.toEqual({ ok: false, error: { code: 'access.unauthenticated' } });
    });
  });

  describe('PurgeExpired (identity.purge-expired)', () => {
    function purge(unitOfWork: UnitOfWork = fakes.unitOfWork) {
      return new PurgeExpired(gate, {
        unitOfWork,
        sessions: fakes.sessionRepository,
        throttles: fakes.throttleRepository,
        records: fakes.recordRepository,
        links: fakes.linkRepository,
        challenges: fakes.challengeRepository,
        invitations: fakes.invitationRepository,
        policy,
        clock,
      });
    }

    it('declares the system rule and refuses any other actor', async () => {
      expect(PurgeExpired.access).toEqual({
        name: 'identity.purge-expired',
        rule: { kind: 'system' },
      });
      await expect(purge().execute(context, {})).resolves.toEqual({
        ok: false,
        error: { code: 'access.denied' },
      });
    });

    it("deletes by the cut-offs of data design 9 and the Market's retention, one day per unit", async () => {
      const cutoffs: Record<string, Temporal.Instant[]> = {
        sessions: [],
        throttles: [],
        records: [],
        links: [],
        challenges: [],
        invitations: [],
      };
      fakes.challengeRepository.purgeExpired = (_m, before) => {
        cutoffs.challenges!.push(before);
        return Promise.resolve(5);
      };
      fakes.invitationRepository.purge = (_m, now, decidedBefore) => {
        cutoffs.invitations!.push(now, decidedBefore);
        return Promise.resolve(6);
      };
      fakes.linkRepository.purgeSpent = (_m, before) => {
        cutoffs.links!.push(before);
        return Promise.resolve(4);
      };
      fakes.sessionRepository.purgeExpired = (_m, before) => {
        cutoffs.sessions!.push(before);
        return Promise.resolve(2);
      };
      fakes.throttleRepository.purge = (_m, before) => {
        cutoffs.throttles!.push(before);
        return Promise.resolve(3);
      };
      const retention = policy.signInRecordRetentionDays(market);
      const cutoff = START.subtract({ hours: retention * 24 });
      fakes.recordRepository.oldest = () => Promise.resolve(cutoff.subtract({ hours: 36 }));
      fakes.recordRepository.deleteBetween = (_m, from, to) => {
        cutoffs.records!.push(from, to);
        return Promise.resolve(1);
      };
      let units = 0;
      const counting: UnitOfWork = {
        run: <T, E>(m: MarketContext, work: () => Promise<Result<T, E>>) => {
          units += 1;
          return fakes.unitOfWork.run(m, work);
        },
        runOnce: (m, delivery, work, options) =>
          fakes.unitOfWork.runOnce(m, delivery, work, options),
      };

      await expect(purge(counting).execute(testCallContext(market, 'system'), {})).resolves.toEqual(
        {
          ok: true,
          value: {
            sessions: 2,
            throttles: 3,
            signInRecords: 2,
            links: 4,
            challenges: 5,
            invitations: 6,
          },
        },
      );
      expect(cutoffs.sessions).toEqual([
        START.subtract({ hours: SESSION_KEPT_AFTER_EXPIRY_HOURS }),
      ]);
      expect(cutoffs.throttles).toEqual([START.subtract({ hours: THROTTLE_KEPT_HOURS })]);
      expect(cutoffs.links).toEqual([START.subtract({ hours: LINK_KEPT_AFTER_SPENT_HOURS })]);
      expect(cutoffs.records).toEqual([
        cutoff.subtract({ hours: 36 }),
        cutoff.subtract({ hours: 12 }),
        cutoff.subtract({ hours: 12 }),
        cutoff,
      ]);
      expect(cutoffs.challenges).toEqual([START]);
      expect(cutoffs.invitations).toEqual([
        START,
        START.subtract({ hours: INVITATION_KEPT_AFTER_DECISION_HOURS }),
      ]);
      // sessions, throttles, the oldest record, two days of records, links, challenges,
      // invitations.
      expect(units).toBe(8);
    });

    it('bounds the record deletes of one run', async () => {
      fakes.recordRepository.oldest = () => Promise.resolve(START.subtract({ hours: 24 * 5000 }));
      let deletes = 0;
      fakes.recordRepository.deleteBetween = () => {
        deletes += 1;
        return Promise.resolve(0);
      };

      await purge().execute(testCallContext(market, 'system'), {});

      expect(deletes).toBe(MAX_RECORD_DAYS_PER_RUN);
    });
  });
});
