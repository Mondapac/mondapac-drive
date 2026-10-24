import { parseId } from '@mondapac-drive/shared-kernel';
import type { Id } from '@mondapac-drive/shared-kernel';
import {
  GrantPolicy,
  type GrantedRole,
  type GrantingActor,
  type ActedOnAccount,
} from './grant-policy';
import { LastHolderPolicy } from './last-holder-policy';

// identity design 5.5 (R1, R3, R11 and its Phase 2 narrowing; HF5 c) and 5.4: GrantPolicy and
// LastHolderPolicy as pure domain services (slice 8a-1). Their callers (assign, invite, remove,
// disable, the role editor) come with slices 8a-2, 8b, 10 and 11.

const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${String(n).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};

const PROTECTED = new Set([
  'identity.admin-account.invite',
  'identity.platform-role.edit',
  'identity.merchant.create',
]);
const catalogue = { isProtected: (key: string) => PROTECTED.has(key) };

const PLATFORM_KEYS = [
  'identity.merchant.view',
  'identity.courier-account.invite',
  'identity.courier-account.view',
  'identity.admin-account.invite',
  'identity.platform-role.edit',
];
const MERCHANT_KEYS = [
  'delivery.quote.create',
  'delivery.booking.create',
  'delivery.booking.view',
  'delivery.booking.cancel',
];

const ADMIN_SYSTEM = id<'Role'>(1);
const MERCHANT_SYSTEM = id<'Role'>(2);
const ONBOARDING = id<'Role'>(3);

const administrator: GrantingActor = {
  accountId: id<'Account'>(101),
  scope: 'platform',
  roleId: ADMIN_SYSTEM,
  holdsSystemRole: true,
  effectiveKeys: new Set(PLATFORM_KEYS),
};
const onboardingAdmin: GrantingActor = {
  accountId: id<'Account'>(102),
  scope: 'platform',
  roleId: ONBOARDING,
  holdsSystemRole: false,
  effectiveKeys: new Set(['identity.merchant.view', 'identity.courier-account.invite']),
};
const merchant: GrantingActor = {
  accountId: id<'Account'>(201),
  scope: 'merchant',
  roleId: MERCHANT_SYSTEM,
  holdsSystemRole: true,
  effectiveKeys: new Set(MERCHANT_KEYS),
};

const role = (over: Partial<GrantedRole> & Pick<GrantedRole, 'id' | 'scope'>): GrantedRole => ({
  kind: 'default',
  effectiveKeys: new Set(),
  ...over,
});

describe('GrantPolicy.canGrant', () => {
  it('lets the Platform Administrator grant a role with any key it holds, protected included', () => {
    expect(
      GrantPolicy.canGrant(
        administrator,
        role({
          id: ONBOARDING,
          scope: 'platform',
          kind: 'custom',
          effectiveKeys: new Set(PLATFORM_KEYS),
        }),
        catalogue,
      ),
    ).toEqual({ ok: true, value: undefined });
  });

  it('R1: refuses a role with a key the actor does not hold', () => {
    expect(
      GrantPolicy.canGrant(
        onboardingAdmin,
        role({
          id: ONBOARDING,
          scope: 'platform',
          effectiveKeys: new Set(['identity.merchant.view', 'identity.courier-account.view']),
        }),
        catalogue,
      ),
    ).toEqual({ ok: false, error: { code: 'role.not-grantable', reason: 'keys-not-held' } });
  });

  it('R1: lets an actor grant a role whose keys are a subset of its own', () => {
    expect(
      GrantPolicy.canGrant(
        onboardingAdmin,
        role({
          id: ONBOARDING,
          scope: 'platform',
          effectiveKeys: new Set(['identity.merchant.view']),
        }),
        catalogue,
      ).ok,
    ).toBe(true);
  });

  it('R11: a protected key is granted only by a holder of the system role of that scope', () => {
    const holder: GrantingActor = {
      ...onboardingAdmin,
      effectiveKeys: new Set([...onboardingAdmin.effectiveKeys, 'identity.admin-account.invite']),
    };
    expect(
      GrantPolicy.canGrant(
        holder,
        role({
          id: ONBOARDING,
          scope: 'platform',
          effectiveKeys: new Set(['identity.admin-account.invite']),
        }),
        catalogue,
      ),
    ).toEqual({ ok: false, error: { code: 'role.not-grantable', reason: 'protected-key' } });
  });

  it('R3, AC 34: a system role is granted only by an actor who holds that same role', () => {
    const systemRole = role({
      id: ADMIN_SYSTEM,
      scope: 'platform',
      kind: 'system',
      effectiveKeys: new Set(PLATFORM_KEYS),
    });
    expect(GrantPolicy.canGrant(administrator, systemRole, catalogue).ok).toBe(true);
    expect(
      GrantPolicy.canGrant(
        { ...onboardingAdmin, effectiveKeys: new Set(PLATFORM_KEYS) },
        systemRole,
        catalogue,
      ),
    ).toEqual({ ok: false, error: { code: 'role.not-grantable', reason: 'system-role' } });
  });

  it('R2: never across scopes, even for a role with no keys', () => {
    expect(
      GrantPolicy.canGrant(administrator, role({ id: MERCHANT_SYSTEM, scope: 'merchant' }), catalogue),
    ).toEqual({ ok: false, error: { code: 'role.not-grantable', reason: 'scope' } });
  });

  it('never grants a merchant or courier role: it is founded with its account', () => {
    for (const scope of ['merchant', 'courier'] as const) {
      const actor: GrantingActor = { ...merchant, scope };
      expect(
        GrantPolicy.canGrant(
          actor,
          role({ id: MERCHANT_SYSTEM, scope, kind: 'system', effectiveKeys: new Set() }),
          catalogue,
        ),
      ).toEqual({ ok: false, error: { code: 'role.not-grantable', reason: 'founded-role' } });
    }
  });
});

describe('GrantPolicy.canActOn', () => {
  const target = (over: Partial<ActedOnAccount>): ActedOnAccount => ({
    accountId: id<'Account'>(301),
    scope: 'platform',
    effectiveKeys: new Set(),
    ...over,
  });

  it('allows an actor whose keys cover the target', () => {
    expect(
      GrantPolicy.canActOn(
        administrator,
        target({ effectiveKeys: new Set(['identity.merchant.view']) }),
      ),
    ).toEqual({ ok: true, value: undefined });
  });

  it('refuses the actor itself: "not on oneself"', () => {
    expect(
      GrantPolicy.canActOn(administrator, target({ accountId: administrator.accountId })),
    ).toEqual({
      ok: false,
      error: { code: 'member.self' },
    });
  });

  it('refuses a target with a key the actor lacks (R1)', () => {
    expect(
      GrantPolicy.canActOn(
        onboardingAdmin,
        target({ effectiveKeys: new Set(['identity.courier-account.view']) }),
      ),
    ).toEqual({ ok: false, error: { code: 'member.outranks-actor' } });
  });

  it('across scopes an admin is decided by its platform permission alone (Ali 14.1-2)', () => {
    expect(
      GrantPolicy.canActOn(
        onboardingAdmin,
        target({ scope: 'merchant', effectiveKeys: new Set(MERCHANT_KEYS) }),
      ).ok,
    ).toBe(true);
    expect(GrantPolicy.canActOn(onboardingAdmin, target({ scope: null })).ok).toBe(true);
  });

  it('a merchant or courier actor never acts on an account outside its scope', () => {
    expect(GrantPolicy.canActOn(merchant, target({ scope: 'platform' }))).toEqual({
      ok: false,
      error: { code: 'member.outranks-actor' },
    });
    expect(GrantPolicy.canActOn(merchant, target({ scope: null }))).toEqual({
      ok: false,
      error: { code: 'member.outranks-actor' },
    });
  });
});

describe('LastHolderPolicy', () => {
  const a = id<'Account'>(401);
  const b = id<'Account'>(402);
  const c = id<'Account'>(403);

  it('refuses to remove, demote or disable the last holder that can sign in (R3, AC 25)', () => {
    expect(LastHolderPolicy.allowsLosing([a], a)).toEqual({
      ok: false,
      error: { code: 'member.last-holder' },
    });
  });

  it('allows it while another holder remains', () => {
    expect(LastHolderPolicy.allowsLosing([a, b], a)).toEqual({ ok: true, value: undefined });
  });

  it('allows a change to an account that is not a holder', () => {
    expect(LastHolderPolicy.allowsLosing([a], c).ok).toBe(true);
  });

  it('counts each holder once', () => {
    expect(LastHolderPolicy.allowsLosing([a, a], a).ok).toBe(false);
  });

  it('answers the predicate the hints of 8.6 row 6 use, the same rule', () => {
    expect(LastHolderPolicy.allowsLosing([], a).ok).toBe(true);
    expect(LastHolderPolicy.wouldLeaveNoHolder([], a)).toBe(false);
    expect(LastHolderPolicy.wouldLeaveNoHolder([a], a)).toBe(true);
  });
});
