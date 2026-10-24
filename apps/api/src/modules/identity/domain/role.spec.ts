import { parseId, parseMarketId, Temporal } from '@mondapac-drive/shared-kernel';
import type { Id, MarketId, Population } from '@mondapac-drive/shared-kernel';
import {
  normalizeRoleName,
  parseRoleName,
  Role,
  RoleAssignment,
  RoleInvariantError,
  scopeOfPopulation,
  type RoleAssignmentState,
  type RoleState,
} from './role';

const NOW = Temporal.Instant.from('2026-10-08T10:00:00Z');

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

const ROLE_ID = id<'Role'>('01990000-0000-7000-8000-0000000000d1');
const ASSIGNMENT_ID = id<'RoleAssignment'>('01990000-0000-7000-8000-0000000000e1');
const ACCOUNT_ID = id<'Account'>('01990000-0000-7000-8000-000000000001');

describe.each(['AU', 'ZZ'])(
  'Role and RoleAssignment in market %s (identity design 2.1, 5.5)',
  (code) => {
    const marketId = market(code);
    const systemRole = (scope: 'platform' | 'merchant' | 'courier') =>
      Role.seedSystem({
        id: ROLE_ID,
        marketId,
        scope,
        seedCode: scope === 'platform' ? 'platform-administrator' : scope,
        seedVersion: 1,
        now: NOW,
      });

    describe('Role.seedSystem (R3; 5.6)', () => {
      it('is a seeded system row of one scope, with no stored keys', () => {
        expect(systemRole('courier').state).toEqual<RoleState>({
          id: ROLE_ID,
          marketId,
          scope: 'courier',
          kind: 'system',
          seedCode: 'courier',
          seedVersion: 1,
          name: null,
          permissionKeys: [],
          version: 1,
          createdAt: NOW,
        });
        expect(systemRole('courier').isSystem).toBe(true);
      });

      it.each([
        ['a seed code that is not a code', { seedCode: 'Courier Role' }],
        ['seed version 0', { seedVersion: 0 }],
        ['an unknown scope', { scope: 'customer' }],
      ] as const)('refuses %s', (_name, overrides) => {
        expect(() =>
          Role.seedSystem({
            id: ROLE_ID,
            marketId,
            scope: 'courier',
            seedCode: 'courier',
            seedVersion: 1,
            now: NOW,
            ...(overrides as object),
          }),
        ).toThrow(RoleInvariantError);
      });

      it('refuses to restore a custom role outside the platform scope', () => {
        expect(() =>
          Role.restore({
            ...systemRole('merchant').state,
            kind: 'custom',
            seedCode: null,
            seedVersion: null,
            name: 'Custom role',
          }),
        ).toThrow(new RoleInvariantError('custom-scope'));
      });
    });

    describe('Role.seedDefault and applySeed (5.6, R3, R10; slice 8a-1)', () => {
      const storeManager = (keys: readonly string[] = ['identity.courier-account.view']) =>
        Role.seedDefault({
          id: ROLE_ID,
          marketId,
          scope: 'platform',
          seedCode: 'dispatcher',
          seedVersion: 1,
          permissionKeys: keys,
          now: NOW,
        });

      it('is a default row of its scope with sorted stored keys', () => {
        const role = storeManager(['identity.courier-account.view', 'delivery.delivery.view']);
        expect(role.state).toMatchObject({
          kind: 'default',
          seedVersion: 1,
          permissionKeys: ['delivery.delivery.view', 'identity.courier-account.view'],
        });
        expect(Object.isFrozen(role.state.permissionKeys)).toBe(true);
        expect(role.persistedVersion).toBeNull();
      });

      it.each([
        ['a malformed key', ['identity.Courier.view']],
        ['a duplicate key', ['identity.courier-account.view', 'identity.courier-account.view']],
      ])('refuses %s', (_name, keys) => {
        expect(() => storeManager(keys)).toThrow(RoleInvariantError);
      });

      it('refuses a system role with stored keys (R3)', () => {
        expect(() =>
          Role.restore({
            ...systemRole('courier').state,
            permissionKeys: ['delivery.assignment.view'],
          }),
        ).toThrow(new RoleInvariantError('keys'));
      });

      it('applies a newer seed key by key, stepping the version and keeping the persisted one', () => {
        const stored = Role.restore({ ...storeManager().state, version: 3 });
        const upgrade = stored.applySeed({
          seedVersion: 2,
          permissionKeys: ['identity.courier-account.invite', 'delivery.delivery.dispatch'],
        });
        expect(upgrade.fromSeedVersion).toBe(1);
        expect(upgrade.addedKeys).toEqual([
          'delivery.delivery.dispatch',
          'identity.courier-account.invite',
        ]);
        expect(upgrade.removedKeys).toEqual(['identity.courier-account.view']);
        expect(upgrade.role.state).toMatchObject({
          seedVersion: 2,
          version: 4,
          permissionKeys: ['delivery.delivery.dispatch', 'identity.courier-account.invite'],
        });
        expect(upgrade.role.persistedVersion).toBe(3);
      });

      it('upgrades a system role without keys (the seed-version upgrade of Ali, PA 14)', () => {
        const upgrade = Role.restore(systemRole('platform').state).applySeed({
          seedVersion: 2,
          permissionKeys: [],
        });
        expect(upgrade).toMatchObject({ fromSeedVersion: 1, addedKeys: [], removedKeys: [] });
        expect(upgrade.role.state.seedVersion).toBe(2);
        expect(() =>
          Role.restore(systemRole('platform').state).applySeed({
            seedVersion: 2,
            permissionKeys: ['identity.platform-role.view'],
          }),
        ).toThrow(new RoleInvariantError('keys'));
      });

      it('never applies an older or equal version, and never touches a custom role (R10)', () => {
        const stored = Role.restore({ ...storeManager().state, seedVersion: 2 });
        for (const seedVersion of [1, 2, 2.5]) {
          expect(() => stored.applySeed({ seedVersion, permissionKeys: [] })).toThrow(
            new RoleInvariantError('seed-upgrade'),
          );
        }
        const custom = Role.restore({
          ...storeManager().state,
          kind: 'custom',
          seedCode: null,
          seedVersion: null,
          name: 'Custom role',
        });
        expect(() => custom.applySeed({ seedVersion: 2, permissionKeys: [] })).toThrow(
          new RoleInvariantError('seed-upgrade'),
        );
      });
    });

    describe('scopeOfPopulation (R2)', () => {
      it.each<[Population, 'platform' | 'merchant' | 'courier']>([
        ['merchant', 'merchant'],
        ['admin', 'platform'],
        ['courier', 'courier'],
      ])('%s -> %s', (population, scope) => {
        expect(scopeOfPopulation(population)).toBe(scope);
      });
    });

    describe('RoleAssignment.found (founding assignment, 5.5)', () => {
      it('gives the system role of the matching scope, with no assigner, version 1', () => {
        const assignment = RoleAssignment.found({
          id: ASSIGNMENT_ID,
          account: { id: ACCOUNT_ID, marketId, population: 'courier' },
          role: systemRole('courier'),
          now: NOW,
        });

        expect(assignment.state).toEqual<RoleAssignmentState>({
          id: ASSIGNMENT_ID,
          marketId,
          accountId: ACCOUNT_ID,
          roleId: ROLE_ID,
          assignedByAccountId: null,
          assignedAt: NOW,
          version: 1,
        });
        expect(assignment.persistedVersion).toBeNull();
      });

      it.each<[string, Population, 'platform' | 'merchant' | 'courier']>([
        ['a courier account the merchant role (R2)', 'courier', 'merchant'],
        ['a merchant account a platform role', 'merchant', 'platform'],
        ['an admin account the courier role', 'admin', 'courier'],
      ])('refuses %s', (_name, population, scope) => {
        expect(() =>
          RoleAssignment.found({
            id: ASSIGNMENT_ID,
            account: { id: ACCOUNT_ID, marketId, population },
            role: systemRole(scope),
            now: NOW,
          }),
        ).toThrow(RoleInvariantError);
      });

      it('refuses a role of another Market', () => {
        const other = market(code === 'AU' ? 'ZZ' : 'AU');

        expect(() =>
          RoleAssignment.found({
            id: ASSIGNMENT_ID,
            account: { id: ACCOUNT_ID, marketId: other, population: 'merchant' },
            role: systemRole('merchant'),
            now: NOW,
          }),
        ).toThrow(RoleInvariantError);
      });
    });
  },
);

describe.each(['AU', 'ZZ'])(
  'the custom role in market %s (identity design 2.1, 5.4; slice 10)',
  (code) => {
    const marketId = market(code);
    const created = (overrides: Partial<Parameters<typeof Role.createCustom>[0]> = {}) =>
      Role.createCustom({
        id: ROLE_ID,
        marketId,
        scope: 'platform',
        name: 'Night shift',
        permissionKeys: ['identity.merchant.view', 'identity.courier-account.view'],
        now: NOW,
        ...overrides,
      });
    const declared = () => true;

    it('is created with a name, sorted keys, version 1 and a created event without the name', () => {
      const role = created();

      expect(role.state).toMatchObject({
        kind: 'custom',
        seedCode: null,
        seedVersion: null,
        name: 'Night shift',
        version: 1,
        permissionKeys: ['identity.courier-account.view', 'identity.merchant.view'],
      });
      expect(role.nameNormalized).toBe('night shift');
      expect(role.persistedVersion).toBeNull();
      expect(role.pendingEvents).toHaveLength(1);
      expect(role.pendingEvents[0]).toMatchObject({
        type: 'identity.role-created.v1',
        payload: {
          scope: 'platform',
          addedKeys: ['identity.courier-account.view', 'identity.merchant.view'],
          removedKeys: [],
        },
      });
      expect(JSON.stringify(role.pendingEvents)).not.toContain('Night');
    });

    it('refuses a custom role of the merchant or courier scope (they hold their system role)', () => {
      for (const scope of ['merchant', 'courier'] as const) {
        expect(() => created({ scope })).toThrow(new RoleInvariantError('custom-scope'));
      }
    });

    it('refuses a malformed, repeated name or key, and a name on a seeded role', () => {
      expect(() => created({ name: '' })).toThrow(new RoleInvariantError('name'));
      expect(() => created({ name: ' padded ' })).toThrow(new RoleInvariantError('name'));
      expect(() => created({ permissionKeys: ['not a key'] })).toThrow(
        new RoleInvariantError('keys'),
      );
      expect(() =>
        created({ permissionKeys: ['identity.merchant.view', 'identity.merchant.view'] }),
      ).toThrow(new RoleInvariantError('keys'));
      const seeded = Role.seedDefault({
        id: ROLE_ID,
        marketId,
        scope: 'platform',
        seedCode: 'viewer',
        seedVersion: 1,
        permissionKeys: [],
        now: NOW,
      });
      expect(() => Role.restore({ ...seeded.state, name: 'Viewer' })).toThrow(
        new RoleInvariantError('name'),
      );
    });

    it('is edited whole: name and keys replaced, version up, added and removed keys named', () => {
      const stored = Role.restore({ ...created().state, version: 3 });

      const edit = stored.edit({
        name: 'Day shift',
        permissionKeys: ['identity.merchant.view', 'identity.admin-account.view'],
        isDeclared: declared,
        now: NOW,
      });

      expect(edit.addedKeys).toEqual(['identity.admin-account.view']);
      expect(edit.removedKeys).toEqual(['identity.courier-account.view']);
      expect(edit.renamed).toBe(true);
      expect(edit.role.state).toMatchObject({ name: 'Day shift', version: 4 });
      expect(edit.role.persistedVersion).toBe(3);
      expect(edit.role.pendingEvents[0]).toMatchObject({
        type: 'identity.role-updated.v1',
        aggregateVersion: 4,
        payload: { addedKeys: ['identity.admin-account.view'] },
      });
      expect(stored.state.name).toBe('Night shift');
    });

    it('lists only keys the registry still declares in an edit, delete and event (R7)', () => {
      const stored = Role.restore({
        ...created().state,
        permissionKeys: ['identity.retired.key', 'identity.merchant.view'],
      });
      const isDeclared = (key: string) => key !== 'identity.retired.key';

      const edit = stored.edit({
        name: 'Night shift',
        permissionKeys: ['identity.merchant.view'],
        isDeclared,
        now: NOW,
      });
      const removed = stored.remove({ isDeclared, now: NOW });

      expect(edit.removedKeys).toEqual([]);
      expect(edit.renamed).toBe(false);
      expect(removed.pendingEvents[0]).toMatchObject({
        type: 'identity.role-deleted.v1',
        payload: { removedKeys: ['identity.merchant.view'], addedKeys: [] },
      });
    });

    it('has no edit or delete path for a system or default role (R3, R10)', () => {
      const system = Role.seedSystem({
        id: ROLE_ID,
        marketId,
        scope: 'platform',
        seedCode: 'platform-administrator',
        seedVersion: 1,
        now: NOW,
      });
      expect(() =>
        system.edit({ name: 'x', permissionKeys: [], isDeclared: declared, now: NOW }),
      ).toThrow(new RoleInvariantError('read-only'));
      expect(() => system.remove({ isDeclared: declared, now: NOW })).toThrow(
        new RoleInvariantError('read-only'),
      );
    });

    describe('names', () => {
      it.each([
        ['  Caf\u00e9  ', 'Caf\u00e9'],
        ['Cafe\u0301', 'Caf\u00e9'],
        ['x'.repeat(80), 'x'.repeat(80)],
      ])('accepts %j as %j', (raw, name) => {
        expect(parseRoleName(raw)).toEqual({ ok: true, value: name });
      });

      it.each([
        ['', 'length'],
        ['   ', 'length'],
        ['x'.repeat(81), 'length'],
        [42, 'length'],
        ['a\u0000b', 'characters'],
        ['a\u0085b', 'characters'],
        ['a\u202eb', 'characters'],
        ['a\ud800b', 'characters'],
      ])('refuses %j (%s)', (raw, rule) => {
        expect(parseRoleName(raw)).toEqual({
          ok: false,
          error: { code: 'role-name.invalid', rule },
        });
      });

      it('normalises case and form for the uniqueness check, not for display', () => {
        expect(normalizeRoleName('CAFE\u0301 Team')).toBe(normalizeRoleName('caf\u00e9 team'));
        expect(normalizeRoleName('Shift A')).not.toBe(normalizeRoleName('Shift B'));
      });
    });
  },
);
