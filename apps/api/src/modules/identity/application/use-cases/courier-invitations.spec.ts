import { parseId, Temporal } from '@mondapac-drive/shared-kernel';
import type { Id } from '@mondapac-drive/shared-kernel';
import {
  FixedClock,
  SequenceIdGenerator,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac-drive/shared-kernel/testing';
import { fakeHashOf, IdentityFakes } from '../../../../../test/support/identity-fakes';
import { realEffectiveKeys } from '../../../../../test/support/permission-registry';
import {
  TEST_MARKETS,
  TEST_MARKET_CONFIG_DIRS,
  TEST_MARKET_IDS,
} from '../../../../../test/support/test-config';
import { createUseCaseGate } from '../../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import { PLATFORM_TENANT_ID } from '../../../../platform/market-context/tenant';
import type { AccountState } from '../../domain/account';
import type { RoleState } from '../../domain/role';
import { MarketConfigIdentityPolicy } from '../../infrastructure/market-config-identity-policy';
import { CheckedInRoleSeed } from '../../infrastructure/seed/checked-in-role-seed';
import {
  INVITATION_TOKEN_PREFIX,
  RandomPrefixedTokens,
} from '../../infrastructure/second-factor/second-factor-tokens';
import { AccountAuthorisationCheck } from '../access/account-authorisation-check';
import type { ThrottleKeys } from '../ports/session-secrets';
import { AcceptCourierInvitation } from './accept-courier-invitation.use-case';
import { InviteCourier } from './invite-courier.use-case';

// Courier onboarding (Drive): a dispatcher invites a courier by address; the courier accepts with
// the mailed token, a name and a password, and gets an active account founded on the Market's
// courier system role. The real gate, registry and checked-in seed; identity's stores as fakes.
// Both Market fixtures, each with its own courier invitation lifetime.

const START = Temporal.Instant.from('2026-10-24T10:00:00Z');
const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const keys: ThrottleKeys = {
  account: (market, population, email) => Buffer.from(`${market.marketId}|${population}|${email}`),
  accountOrigin: (market, population, email, origin) =>
    Buffer.from(`${market.marketId}|${population}|${email}|${origin}`),
  origin: (market, origin) => Buffer.from(`${market.marketId}|${origin}`),
};
const ORIGIN = '203.0.113.9';
const CLIENT = { origin: ORIGIN, address: ORIGIN };
const PASSWORD = 'a long and unusual passphrase 42';
const EMAIL = 'new.courier@example.com';

const id = <T extends string>(text: string): Id<T> => {
  const parsed = parseId(text);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const n12 = (n: number) => String(n).padStart(12, '0');
const accountId = (n: number) => id<'Account'>(`01990000-0000-7000-8000-${n12(0xa000 + n)}`);
const OPERATOR = accountId(2);
const DISPATCHER = accountId(3);

describe.each(TEST_MARKETS)('courier invitations in market %s', (code) => {
  const market = testMarketContext(code, PLATFORM_TENANT_ID);
  const marketId = code as AccountState['marketId'];
  const policy = new MarketConfigIdentityPolicy(markets);
  const tokens = new RandomPrefixedTokens(INVITATION_TOKEN_PREFIX);
  let fakes: IdentityFakes;
  let roles: Map<string, RoleState>;
  let clock: FixedClock;

  function setUp() {
    fakes = new IdentityFakes();
    clock = new FixedClock(START);
    roles = new Map();
    new CheckedInRoleSeed().roles().forEach((seeded, n) => {
      const role: RoleState = {
        id: id<'Role'>(`01990000-0000-7000-8000-${n12(0xc000 + n)}`),
        marketId,
        scope: seeded.scope,
        kind: seeded.kind,
        seedCode: seeded.seedCode,
        seedVersion: seeded.seedVersion,
        permissionKeys: seeded.kind === 'system' ? [] : [...seeded.permissionKeys].sort(),
        version: 1,
        createdAt: START,
      };
      fakes.seedRole(role);
      roles.set(`${seeded.scope}:${seeded.seedCode}`, role);
    });
    const admin = (n: number, idOf: Id<'Account'>, seedCode: string) => {
      fakes.seedAccount({
        id: idOf,
        marketId,
        population: 'admin',
        email: { typed: `a${n}@example.com`, normalized: `a${n}@example.com` },
        displayName: `Admin ${n}`,
        status: 'active',
        emailVerifiedAt: START,
        signedUpAt: START,
        createdAt: START,
        version: 1,
        credential: { passwordHash: fakeHashOf('x'), changedAt: START },
      });
      fakes.seedAssignment({
        id: id<'RoleAssignment'>(`01990000-0000-7000-8000-${n12(0xe100 + n)}`),
        marketId,
        accountId: idOf,
        roleId: roles.get(`platform:${seedCode}`)!.id,
        assignedByAccountId: null,
        assignedAt: START,
        version: 1,
      });
    };
    admin(2, OPERATOR, 'operator');
    admin(3, DISPATCHER, 'dispatcher');

    const effectiveKeys = realEffectiveKeys();
    const gate = createUseCaseGate(
      markets,
      new AccountAuthorisationCheck({
        unitOfWork: fakes.unitOfWork,
        accounts: fakes.accountRepository,
        memberships: fakes.membershipRepository,
        merchants: fakes.merchantRepository,
        grants: fakes.grantReader,
        effectiveKeys,
      }),
    );
    const deps = {
      unitOfWork: fakes.unitOfWork,
      accounts: fakes.accountRepository,
      grants: fakes.grantReader,
      effectiveKeys,
      invitations: fakes.invitationRepository,
      throttles: fakes.throttleRepository,
      keys,
      outbox: fakes.outbox,
      audit: fakes.audit,
      policy,
      clock,
      ids: new SequenceIdGenerator(clock),
    };
    return {
      invite: new InviteCourier(gate, { ...deps, roles: fakes.roleRepository }),
      accept: new AcceptCourierInvitation(gate, {
        ...deps,
        roles: fakes.roleRepository,
        assignments: fakes.assignmentRepository,
        invitationTokens: tokens,
        hasher: fakes.hasher,
        commonPasswords: { isCommon: () => false },
      }),
    };
  }

  const as = (account: Id<'Account'>) =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'admin',
        accountId: account,
        sessionId: id<'Session'>('01990000-0000-7000-8000-00000000f001'),
        merchantId: null,
      }),
      'courier-invitations-0001',
    );
  const anonymous = () => testCallContext(market, 'anonymous', 'courier-accept-0001');

  /** The mail handler's step (6.6): a token minted and its hash stored on the invitation. */
  function dispatched(invitationId: Id<'Invitation'>): string {
    const { token, tokenHash } = tokens.issue();
    const state = fakes.invitations.get(invitationId)!;
    fakes.invitations.set(invitationId, {
      ...state,
      tokenHash,
      expiresAt: clock.now().add({ minutes: policy.invitationLifetimeMinutes(market, 'courier')! }),
      version: state.version + 1,
    });
    return token;
  }

  async function invited(useCases: ReturnType<typeof setUp>, email = EMAIL) {
    const result = await useCases.invite.execute(as(DISPATCHER), { email, origin: ORIGIN });
    if (!result.ok) throw new Error(`invite: ${result.error.code}`);
    return result.value.invitationId;
  }

  describe('InviteCourier', () => {
    it('lets a dispatcher invite a courier to the courier system role, audited without the address', async () => {
      const useCases = setUp();

      const result = await useCases.invite.execute(as(DISPATCHER), {
        email: 'New.Courier@Example.com',
        origin: ORIGIN,
      });

      expect(result).toMatchObject({
        ok: true,
        value: { code: 'invitation.issued', replaced: false },
      });
      const invitation = [...fakes.invitations.values()][0]!;
      const courierRole = roles.get('courier:courier')!.id;
      expect(invitation).toMatchObject({
        marketId: code,
        kind: 'courier',
        state: 'pending',
        roleId: courierRole,
        invitedByAccountId: DISPATCHER,
        tokenHash: null,
        email: { normalized: EMAIL },
      });
      expect(fakes.audits).toEqual([
        expect.objectContaining({
          action: 'identity.invitation.issued',
          targetId: invitation.id,
          after: { kind: 'courier', roleId: courierRole },
          marketId: code,
        }),
      ]);
      expect(JSON.stringify(fakes.audits).toLowerCase()).not.toContain('new.courier');
      expect(fakes.events.map((event) => event.type)).toContain('identity.invitation-issued.v1');
    });

    it('refuses an operator, who may not onboard couriers', async () => {
      const { invite } = setUp();

      await expect(invite.execute(as(OPERATOR), { email: EMAIL, origin: ORIGIN })).resolves.toEqual(
        { ok: false, error: { code: 'access.denied' } },
      );
      expect(fakes.invitations.size).toBe(0);
    });

    it('refuses a malformed address, an address with a courier account and a fresh pending invitation', async () => {
      const useCases = setUp();
      await expect(
        useCases.invite.execute(as(DISPATCHER), { email: 'not an address', origin: ORIGIN }),
      ).resolves.toMatchObject({ ok: false, error: { code: 'validation.failed' } });

      await invited(useCases);
      await expect(
        useCases.invite.execute(as(DISPATCHER), { email: EMAIL, origin: ORIGIN }),
      ).resolves.toEqual({ ok: false, error: { code: 'invitation.already-pending' } });

      fakes.seedAccount({
        id: accountId(9),
        marketId,
        population: 'courier',
        email: { typed: 'taken@example.com', normalized: 'taken@example.com' },
        displayName: 'Taken',
        status: 'active',
        emailVerifiedAt: START,
        signedUpAt: START,
        createdAt: START,
        version: 1,
        credential: { passwordHash: fakeHashOf('x'), changedAt: START },
      });
      await expect(
        useCases.invite.execute(as(DISPATCHER), { email: 'taken@example.com', origin: ORIGIN }),
      ).resolves.toEqual({ ok: false, error: { code: 'account.exists' } });
    });

    it('replaces a never-dispatched invitation once its lifetime has passed, and audits the revoke', async () => {
      const useCases = setUp();
      const first = await invited(useCases);
      clock.advance(
        Temporal.Duration.from({ minutes: policy.invitationLifetimeMinutes(market, 'courier')! }),
      );

      const second = await useCases.invite.execute(as(DISPATCHER), {
        email: EMAIL,
        origin: ORIGIN,
      });

      expect(second).toMatchObject({ ok: true, value: { replaced: true } });
      expect(fakes.invitations.get(first)!.state).toBe('revoked');
      expect(fakes.audits.map((audit) => audit.action)).toEqual([
        'identity.invitation.issued',
        'identity.invitation.revoked',
        'identity.invitation.issued',
      ]);
    });
  });

  describe('AcceptCourierInvitation', () => {
    it('creates an active, verified courier account founded on the courier role', async () => {
      const useCases = setUp();
      const invitationId = await invited(useCases);
      const token = dispatched(invitationId);

      const result = await useCases.accept.execute(anonymous(), {
        token,
        password: PASSWORD,
        displayName: 'Sam Courier',
        client: CLIENT,
      });

      expect(result).toEqual({ ok: true, value: { code: 'invitation.accepted' } });
      const account = [...fakes.accounts.values()].find((a) => a.population === 'courier')!;
      expect(account).toMatchObject({
        marketId: code,
        status: 'active',
        displayName: 'Sam Courier',
        email: { normalized: EMAIL },
      });
      expect(account.emailVerifiedAt).not.toBeNull();
      const courierRole = roles.get('courier:courier')!.id;
      expect([...fakes.assignments.values()].filter((a) => a.accountId === account.id)).toEqual([
        expect.objectContaining({ roleId: courierRole, assignedByAccountId: null }),
      ]);
      expect(fakes.invitations.get(invitationId)).toMatchObject({
        state: 'accepted',
        acceptedAccountId: account.id,
      });
      expect(fakes.audits.slice(-2)).toEqual([
        expect.objectContaining({ action: 'identity.invitation.accepted', actor: 'anonymous' }),
        expect.objectContaining({ action: 'identity.account-role.assigned', targetId: account.id }),
      ]);
      expect(fakes.audits.at(-1)!.after).toMatchObject({
        scope: 'courier',
        founding: true,
        roleId: courierRole,
      });
      const serialised = JSON.stringify(fakes.audits);
      for (const secret of [token, PASSWORD, 'Sam Courier']) {
        expect(serialised).not.toContain(secret);
      }
    });

    it('rejects an unknown token, a used one and an expired one alike', async () => {
      const useCases = setUp();
      const invitationId = await invited(useCases);
      const token = dispatched(invitationId);
      const attempt = (value: string) =>
        useCases.accept.execute(anonymous(), {
          token: value,
          password: PASSWORD,
          displayName: 'Sam Courier',
          client: CLIENT,
        });

      await expect(attempt(`${INVITATION_TOKEN_PREFIX}unknown`)).resolves.toEqual({
        ok: false,
        error: { code: 'invitation.rejected' },
      });
      await expect(attempt(token)).resolves.toMatchObject({ ok: true });
      await expect(attempt(token)).resolves.toEqual({
        ok: false,
        error: { code: 'invitation.rejected' },
      });

      const later = await invited(useCases, 'later@example.com');
      const laterToken = dispatched(later);
      clock.advance(
        Temporal.Duration.from({ minutes: policy.invitationLifetimeMinutes(market, 'courier')! }),
      );
      await expect(attempt(laterToken)).resolves.toEqual({
        ok: false,
        error: { code: 'invitation.rejected' },
      });
      expect([...fakes.accounts.values()].filter((a) => a.population === 'courier')).toHaveLength(
        1,
      );
    });

    it('rejects the invitation of a dispatcher who lost the right to invite since', async () => {
      const useCases = setUp();
      const invitationId = await invited(useCases);
      const token = dispatched(invitationId);
      const [assignmentId] = [...fakes.assignments.entries()].find(
        ([, assignment]) => assignment.accountId === DISPATCHER,
      )!;
      fakes.assignments.set(assignmentId, {
        ...fakes.assignments.get(assignmentId)!,
        roleId: roles.get('platform:operator')!.id,
      });

      const result = await useCases.accept.execute(anonymous(), {
        token,
        password: PASSWORD,
        displayName: 'Sam Courier',
        client: CLIENT,
      });

      expect(result).toEqual({ ok: false, error: { code: 'invitation.rejected' } });
      expect([...fakes.accounts.values()].some((a) => a.population === 'courier')).toBe(false);
      expect(fakes.invitations.get(invitationId)!.state).toBe('pending');
    });

    it('refuses a short password and a blank name before anything is written', async () => {
      const useCases = setUp();
      const token = dispatched(await invited(useCases));

      const short = await useCases.accept.execute(anonymous(), {
        token,
        password: 'short',
        displayName: 'Sam Courier',
        client: CLIENT,
      });
      const blank = await useCases.accept.execute(anonymous(), {
        token,
        password: PASSWORD,
        displayName: '   ',
        client: CLIENT,
      });

      expect(short.ok).toBe(false);
      expect(blank).toMatchObject({ ok: false, error: { code: 'validation.failed' } });
      expect([...fakes.accounts.values()].some((a) => a.population === 'courier')).toBe(false);
    });
  });
});
