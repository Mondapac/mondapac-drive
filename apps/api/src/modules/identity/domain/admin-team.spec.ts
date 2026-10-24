import { parseId, parseMarketId, Temporal } from '@mondapac-drive/shared-kernel';
import type { Id, MarketId, Population } from '@mondapac-drive/shared-kernel';
import { Account, statusChangeRefusal } from './account';
import { parseEmailAddress } from './email-address';
import { Invitation, invitationReissuableAt, invitationStatusAt } from './invitation';
import { Role, RoleAssignment, RoleInvariantError } from './role';

// Slice 8a-2 and 8b in the domain (identity design 3.1, 3.4, 5.5, 8.2): disabling and enabling an
// account, granting and changing a role, re-sending and revoking an invitation. Both Market
// fixtures; nothing assumes AU's values.

const NOW = Temporal.Instant.from('2026-10-08T10:00:00Z');
const LATER = NOW.add({ minutes: 5 });
/** The admin invitation lifetime of a Market, in minutes (72 hours). */
const LIFETIME = 72 * 60;
const HASH = '$argon2id$v=19$m=65536,t=3,p=1$c2FsdHNhbHRzYWx0c2FsdA$dGFndGFndGFn';
const TOKEN_HASH = new Uint8Array(32).fill(7);

function id<K extends string>(text: string): Id<K> {
  const parsed = parseId<K>(text);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value;
}
function market(code: string): MarketId {
  const parsed = parseMarketId(code);
  if (!parsed.ok) throw new Error('bad market');
  return parsed.value;
}
const email = (raw: string) => {
  const parsed = parseEmailAddress(raw);
  if (!parsed.ok) throw new Error('bad email');
  return parsed.value;
};

const ACCOUNT_ID = id<'Account'>('01990000-0000-7000-8000-000000000001');
const ADMIN_ID = id<'Account'>('01990000-0000-7000-8000-000000000002');
const SYSTEM_ROLE_ID = id<'Role'>('01990000-0000-7000-8000-0000000000d1');
const DEFAULT_ROLE_ID = id<'Role'>('01990000-0000-7000-8000-0000000000d2');
const ASSIGNMENT_ID = id<'RoleAssignment'>('01990000-0000-7000-8000-0000000000e1');
const INVITATION_ID = id<'Invitation'>('01990000-0000-7000-8000-0000000000c1');

describe.each(['AU', 'ZZ'])('slice 8a-2 and 8b domain in market %s', (code) => {
  const marketId = market(code);

  const accountOf = (population: Population, status: 'active' | 'disabled' = 'active') =>
    Account.restore({
      id: ACCOUNT_ID,
      marketId,
      population,
      email: { typed: 'Person@Example.com', normalized: 'person@example.com' },
      displayName: 'Person',
      status,
      emailVerifiedAt: NOW,
      signedUpAt: NOW,
      createdAt: NOW,
      version: 3,
      credential: { passwordHash: HASH, changedAt: NOW },
    });

  describe('Account.disable and enable (identity design 3.1)', () => {
    it.each<Population>(['admin', 'courier'])(
      'disables an active %s account: version +1 and account-disabled',
      (population) => {
        const account = accountOf(population);

        expect(account.disable(LATER)).toEqual({ ok: true, value: undefined });

        expect(account.state).toMatchObject({ status: 'disabled', version: 4 });
        expect(account.persistedVersion).toBe(3);
        expect(account.pendingEvents).toEqual([
          expect.objectContaining({
            type: 'identity.account-disabled.v1',
            aggregateId: ACCOUNT_ID,
            aggregateVersion: 4,
            occurredAt: LATER,
            payload: { accountId: ACCOUNT_ID, population },
          }),
        ]);
      },
    );

    it.each<Population>(['admin', 'courier'])(
      'enables a disabled %s account: version +1 and account-enabled',
      (population) => {
        const account = accountOf(population, 'disabled');

        expect(account.enable(LATER)).toEqual({ ok: true, value: undefined });

        expect(account.state).toMatchObject({ status: 'active', version: 4 });
        expect(account.pendingEvents).toEqual([
          expect.objectContaining({
            type: 'identity.account-enabled.v1',
            aggregateVersion: 4,
            payload: { accountId: ACCOUNT_ID, population },
          }),
        ]);
      },
    );

    it('refuses a second disable and a second enable, changing nothing', () => {
      const disabled = accountOf('admin', 'disabled');
      const active = accountOf('admin');

      expect(disabled.disable(LATER)).toEqual({
        ok: false,
        error: { code: 'account.already-disabled' },
      });
      expect(active.enable(LATER)).toEqual({
        ok: false,
        error: { code: 'account.already-active' },
      });
      expect(disabled.state.version).toBe(3);
      expect(active.state.version).toBe(3);
      expect([...disabled.pendingEvents, ...active.pendingEvents]).toEqual([]);
    });

    it("never disables or enables a merchant's integration account by this path (3.1)", () => {
      const merchant = accountOf('merchant');
      const disabledMerchant = accountOf('merchant', 'disabled');

      expect(merchant.disable(LATER)).toEqual({
        ok: false,
        error: { code: 'account.not-eligible' },
      });
      expect(disabledMerchant.enable(LATER)).toEqual({
        ok: false,
        error: { code: 'account.not-eligible' },
      });
      expect(merchant.state.status).toBe('active');
      expect(merchant.pendingEvents).toEqual([]);
    });
  });

  describe('statusChangeRefusal (slice 8c: the one answer of disable, enable and the hint)', () => {
    it('answers what disable and enable answer, for every population and status', () => {
      for (const population of ['admin', 'courier', 'merchant'] as const) {
        for (const status of ['active', 'disabled'] as const) {
          for (const to of ['active', 'disabled'] as const) {
            const account = accountOf(population, status);
            const changed = to === 'disabled' ? account.disable(LATER) : account.enable(LATER);
            const refusal = statusChangeRefusal(population, status, to);
            expect(refusal).toEqual(changed.ok ? null : changed.error);
          }
        }
      }
    });
  });

  describe('RoleAssignment.grant and reassign (identity design 5.5, 8.2; slice 8a-2)', () => {
    const systemRole = Role.seedSystem({
      id: SYSTEM_ROLE_ID,
      marketId,
      scope: 'platform',
      seedCode: 'platform-administrator',
      seedVersion: 1,
      now: NOW,
    });
    const defaultRole = Role.seedDefault({
      id: DEFAULT_ROLE_ID,
      marketId,
      scope: 'platform',
      seedCode: 'viewer',
      seedVersion: 1,
      permissionKeys: ['identity.merchant.view'],
      now: NOW,
    });
    const courierRole = Role.seedSystem({
      id: id<'Role'>('01990000-0000-7000-8000-0000000000d3'),
      marketId,
      scope: 'courier',
      seedCode: 'courier',
      seedVersion: 1,
      now: NOW,
    });
    const admin = { id: ACCOUNT_ID, marketId, population: 'admin' as const };

    it('grants a role with its assigner, version 1 and no event (the acceptance names it)', () => {
      const assignment = RoleAssignment.grant({
        id: ASSIGNMENT_ID,
        account: admin,
        role: defaultRole,
        assignedBy: ADMIN_ID,
        now: NOW,
      });

      expect(assignment.state).toEqual({
        id: ASSIGNMENT_ID,
        marketId,
        accountId: ACCOUNT_ID,
        roleId: DEFAULT_ROLE_ID,
        assignedByAccountId: ADMIN_ID,
        assignedAt: NOW,
        version: 1,
      });
      expect(assignment.pendingEvents).toEqual([]);
    });

    it.each<[string, Population, Role]>([
      ['a courier a platform role (R2)', 'courier', defaultRole],
      ['a merchant account a platform role', 'merchant', defaultRole],
      ['an admin account the courier role', 'admin', courierRole],
    ])('refuses to grant %s', (_name, population, role) => {
      expect(() =>
        RoleAssignment.grant({
          id: ASSIGNMENT_ID,
          account: { id: ACCOUNT_ID, marketId, population },
          role,
          assignedBy: ADMIN_ID,
          now: NOW,
        }),
      ).toThrow(RoleInvariantError);
    });

    it('founds a courier on the courier system role, and never on a default role', () => {
      const courier = { id: ACCOUNT_ID, marketId, population: 'courier' as const };
      expect(
        RoleAssignment.found({ id: ASSIGNMENT_ID, account: courier, role: courierRole, now: NOW })
          .state,
      ).toMatchObject({ roleId: courierRole.state.id, assignedByAccountId: null, version: 1 });
      expect(() =>
        RoleAssignment.found({ id: ASSIGNMENT_ID, account: admin, role: defaultRole, now: NOW }),
      ).toThrow(new RoleInvariantError('founding-role'));
    });

    it('reassigns: the new role, the assigner, version +1 and account-role-changed', () => {
      const assignment = RoleAssignment.restore({
        id: ASSIGNMENT_ID,
        marketId,
        accountId: ACCOUNT_ID,
        roleId: SYSTEM_ROLE_ID,
        assignedByAccountId: null,
        assignedAt: NOW,
        version: 2,
      });

      expect(
        assignment.reassign({
          account: admin,
          role: defaultRole,
          assignedBy: ADMIN_ID,
          now: LATER,
        }),
      ).toBe('changed');

      expect(assignment.state).toMatchObject({
        roleId: DEFAULT_ROLE_ID,
        assignedByAccountId: ADMIN_ID,
        assignedAt: LATER,
        version: 3,
      });
      expect(assignment.persistedVersion).toBe(2);
      expect(assignment.pendingEvents).toEqual([
        expect.objectContaining({
          type: 'identity.account-role-changed.v1',
          aggregateId: ASSIGNMENT_ID,
          aggregateVersion: 3,
          payload: {
            accountId: ACCOUNT_ID,
            scope: 'platform',
            previousRoleId: SYSTEM_ROLE_ID,
            roleId: DEFAULT_ROLE_ID,
          },
        }),
      ]);
    });

    it('changes nothing when the role is the one held', () => {
      const assignment = RoleAssignment.restore({
        id: ASSIGNMENT_ID,
        marketId,
        accountId: ACCOUNT_ID,
        roleId: DEFAULT_ROLE_ID,
        assignedByAccountId: null,
        assignedAt: NOW,
        version: 2,
      });

      expect(
        assignment.reassign({
          account: admin,
          role: defaultRole,
          assignedBy: ADMIN_ID,
          now: LATER,
        }),
      ).toBe('unchanged');
      expect(assignment.state.version).toBe(2);
      expect(assignment.pendingEvents).toEqual([]);
    });

    it('refuses a reassignment to another account or across scopes', () => {
      const assignment = RoleAssignment.restore({
        id: ASSIGNMENT_ID,
        marketId,
        accountId: ACCOUNT_ID,
        roleId: DEFAULT_ROLE_ID,
        assignedByAccountId: null,
        assignedAt: NOW,
        version: 2,
      });

      expect(() =>
        assignment.reassign({
          account: { ...admin, id: ADMIN_ID },
          role: systemRole,
          assignedBy: ADMIN_ID,
          now: LATER,
        }),
      ).toThrow(RoleInvariantError);
      expect(() =>
        assignment.reassign({
          account: admin,
          role: courierRole,
          assignedBy: ADMIN_ID,
          now: LATER,
        }),
      ).toThrow(RoleInvariantError);
    });
  });

  describe('Invitation.reissue and revoke (identity design 3.4, 8.2; slice 8b)', () => {
    const issued = () =>
      Invitation.issue({
        id: INVITATION_ID,
        marketId,
        kind: 'admin',
        email: email('New.Admin@Example.test'),
        roleId: DEFAULT_ROLE_ID,
        invitedByAccountId: ADMIN_ID,
        now: NOW,
      });
    const dispatched = () => {
      const invitation = Invitation.restore(issued().state);
      invitation.dispatch(TOKEN_HASH, NOW, 60);
      return Invitation.restore(invitation.state);
    };

    it('re-sends: the token voided at once, version +1 and invitation-issued again', () => {
      const invitation = dispatched();

      expect(invitation.reissue(LATER, LIFETIME)).toEqual({ ok: true, value: undefined });

      expect(invitation.state).toMatchObject({
        state: 'pending',
        tokenHash: null,
        expiresAt: null,
        version: 3,
        invitedByAccountId: ADMIN_ID,
      });
      expect(invitation.usableAt(LATER)).toBe(false);
      expect(invitation.pendingEvents).toEqual([
        expect.objectContaining({
          type: 'identity.invitation-issued.v1',
          aggregateVersion: 3,
          payload: { invitationId: INVITATION_ID, kind: 'admin' },
        }),
      ]);
    });

    it('re-sends a pending invitation whose token expired, within the kind lifetime', () => {
      const invitation = dispatched();
      const afterExpiry = NOW.add({ minutes: 61 });

      expect(invitation.statusAt(afterExpiry)).toBe('expired');
      expect(invitation.reissue(afterExpiry, LIFETIME)).toEqual({ ok: true, value: undefined });
      expect(invitation.statusAt(afterExpiry)).toBe('pending');
    });

    it('refuses a re-send at and after createdAt plus the kind lifetime (Mohammad C2)', () => {
      const lastMinute = NOW.add({ minutes: LIFETIME - 1 });
      const cutoff = NOW.add({ minutes: LIFETIME });

      expect(dispatched().reissue(lastMinute, LIFETIME)).toEqual({ ok: true, value: undefined });
      const late = dispatched();
      expect(late.reissue(cutoff, LIFETIME)).toEqual({
        ok: false,
        error: { code: 'invitation.rejected' },
      });
      expect(late.pendingEvents).toEqual([]);
      expect(late.state.tokenHash).not.toBeNull();
      expect(() => dispatched().reissue(NOW, 0)).toThrow(RangeError);
    });

    it('reissuableAt answers what reissue answers, and changes nothing (slice 8c hint)', () => {
      const lastMinute = NOW.add({ minutes: LIFETIME - 1 });
      const cutoff = NOW.add({ minutes: LIFETIME });
      const invitation = dispatched();

      expect(invitation.reissuableAt(lastMinute, LIFETIME)).toBe(true);
      expect(invitation.reissuableAt(cutoff, LIFETIME)).toBe(false);
      expect(invitation.state.version).toBe(2);
      expect(invitation.pendingEvents).toEqual([]);
      const revoked = dispatched();
      revoked.revoke(LATER);
      expect(Invitation.restore(revoked.state).reissuableAt(LATER, LIFETIME)).toBe(false);
      expect(() => invitation.reissuableAt(NOW, 0)).toThrow(RangeError);
    });

    it('the pure rules answer what the aggregate answers, from the summary fields (slice 8c)', () => {
      const at = [NOW, NOW.add({ minutes: 61 }), NOW.add({ minutes: LIFETIME })];
      const revoked = dispatched();
      revoked.revoke(LATER);
      for (const invitation of [dispatched(), issued(), Invitation.restore(revoked.state)]) {
        const { state, expiresAt, createdAt } = invitation.state;
        for (const now of at) {
          expect(invitationStatusAt({ state, expiresAt }, now)).toBe(invitation.statusAt(now));
          expect(invitationReissuableAt({ state, createdAt }, now, LIFETIME)).toBe(
            invitation.reissuableAt(now, LIFETIME),
          );
        }
      }
    });

    it('revokes: the address cleared, version +1 and invitation-revoked', () => {
      const invitation = dispatched();

      expect(invitation.revoke(LATER)).toEqual({ ok: true, value: undefined });

      expect(invitation.state).toMatchObject({
        state: 'revoked',
        email: null,
        decidedAt: LATER,
        version: 3,
      });
      expect(invitation.pendingEvents).toEqual([
        expect.objectContaining({
          type: 'identity.invitation-revoked.v1',
          aggregateVersion: 3,
          payload: { invitationId: INVITATION_ID, kind: 'admin' },
        }),
      ]);
    });

    it('refuses to re-send or revoke a decided invitation', () => {
      const invitation = dispatched();
      invitation.revoke(LATER);
      const decided = Invitation.restore(invitation.state);

      expect(decided.reissue(LATER, LIFETIME)).toEqual({
        ok: false,
        error: { code: 'invitation.rejected' },
      });
      expect(decided.revoke(LATER)).toEqual({ ok: false, error: { code: 'invitation.rejected' } });
      expect(decided.pendingEvents).toEqual([]);
    });
  });
});
