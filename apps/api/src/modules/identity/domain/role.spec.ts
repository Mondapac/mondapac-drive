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
    const systemRole = (scope: 'platform' | 'seller') =>
      Role.seedSystem({
        id: ROLE_ID,
        marketId,
        scope,
        seedCode: scope === 'seller' ? 'seller-owner' : 'platform-administrator',
        seedVersion: 1,
        now: NOW,
      });

    describe('Role.seedSystem (R3; 5.6)', () => {
      it('is a seeded system row of one scope, with no stored keys and no seller', () => {
        expect(systemRole('seller').state).toEqual<RoleState>({
          id: ROLE_ID,
          marketId,
          scope: 'seller',
          kind: 'system',
          seedCode: 'seller-owner',
          seedVersion: 1,
          sellerId: null,
          name: null,
          permissionKeys: [],
          version: 1,
          createdAt: NOW,
        });
        expect(systemRole('seller').isSystem).toBe(true);
      });

      it.each([
        ['a seed code that is not a code', { seedCode: 'Seller Owner' }],
        ['seed version 0', { seedVersion: 0 }],
        ['an unknown scope', { scope: 'customer' }],
      ] as const)('refuses %s', (_name, overrides) => {
        expect(() =>
          Role.seedSystem({
            id: ROLE_ID,
            marketId,
            scope: 'seller',
            seedCode: 'seller-owner',
            seedVersion: 1,
            now: NOW,
            ...(overrides as object),
          }),
        ).toThrow(RoleInvariantError);
      });

      it('refuses to restore a system role with a seller (R9: only custom seller roles have one)', () => {
        expect(() =>
          Role.restore({
            ...systemRole('seller').state,
            sellerId: id<'Seller'>('01990000-0000-7000-8000-0000000000a1'),
          }),
        ).toThrow(RoleInvariantError);
      });
    });

    describe('Role.seedDefault and applySeed (5.6, R3, R10; slice 8a-1)', () => {
      const storeManager = (keys: readonly string[] = ['identity.team-member.view']) =>
        Role.seedDefault({
          id: ROLE_ID,
          marketId,
          scope: 'seller',
          seedCode: 'store-manager',
          seedVersion: 1,
          permissionKeys: keys,
          now: NOW,
        });

      it('is a shared default row of its scope (no seller, R9) with sorted stored keys', () => {
        const role = storeManager(['identity.seller-role.view', 'identity.team-member.view']);
        expect(role.state).toMatchObject({
          kind: 'default',
          sellerId: null,
          seedVersion: 1,
          permissionKeys: ['identity.seller-role.view', 'identity.team-member.view'],
        });
        expect(Object.isFrozen(role.state.permissionKeys)).toBe(true);
        expect(role.persistedVersion).toBeNull();
      });

      it.each([
        ['a malformed key', ['identity.Team.view']],
        ['a duplicate key', ['identity.team-member.view', 'identity.team-member.view']],
      ])('refuses %s', (_name, keys) => {
        expect(() => storeManager(keys)).toThrow(RoleInvariantError);
      });

      it('refuses a system role with stored keys (R3)', () => {
        expect(() =>
          Role.restore({
            ...systemRole('seller').state,
            permissionKeys: ['identity.team-member.view'],
          }),
        ).toThrow(new RoleInvariantError('keys'));
      });

      it('applies a newer seed key by key, stepping the version and keeping the persisted one', () => {
        const stored = Role.restore({ ...storeManager().state, version: 3 });
        const upgrade = stored.applySeed({
          seedVersion: 2,
          permissionKeys: ['identity.seller-role.view', 'catalog.offer.edit'],
        });
        expect(upgrade.fromSeedVersion).toBe(1);
        expect(upgrade.addedKeys).toEqual(['catalog.offer.edit', 'identity.seller-role.view']);
        expect(upgrade.removedKeys).toEqual(['identity.team-member.view']);
        expect(upgrade.role.state).toMatchObject({
          seedVersion: 2,
          version: 4,
          permissionKeys: ['catalog.offer.edit', 'identity.seller-role.view'],
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
          sellerId: id<'Seller'>('01990000-0000-7000-8000-0000000000a1'),
          name: 'Custom role',
        });
        expect(() => custom.applySeed({ seedVersion: 2, permissionKeys: [] })).toThrow(
          new RoleInvariantError('seed-upgrade'),
        );
      });
    });

    describe('scopeOfPopulation (R2)', () => {
      it.each<[Population, 'platform' | 'seller' | null]>([
        ['seller', 'seller'],
        ['admin', 'platform'],
        ['customer', null],
      ])('%s -> %s', (population, scope) => {
        expect(scopeOfPopulation(population)).toBe(scope);
      });
    });

    describe('RoleAssignment.found (founding assignment, 5.5)', () => {
      it('gives the system role of the matching scope, with no assigner, version 1', () => {
        const assignment = RoleAssignment.found({
          id: ASSIGNMENT_ID,
          account: { id: ACCOUNT_ID, marketId, population: 'seller' },
          role: systemRole('seller'),
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

      it.each<[string, Population, 'platform' | 'seller']>([
        ['a customer, whatever the role (R2)', 'customer', 'seller'],
        ['a seller account a platform role', 'seller', 'platform'],
        ['an admin account a seller role', 'admin', 'seller'],
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
            account: { id: ACCOUNT_ID, marketId: other, population: 'seller' },
            role: systemRole('seller'),
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
    const SELLER = id<'Seller'>('01990000-0000-7000-8000-0000000000a1');
    const created = (overrides: Partial<Parameters<typeof Role.createCustom>[0]> = {}) =>
      Role.createCustom({
        id: ROLE_ID,
        marketId,
        scope: 'platform',
        sellerId: null,
        name: 'Night shift',
        permissionKeys: ['identity.seller-access.view', 'identity.customer-account.view'],
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
        permissionKeys: ['identity.customer-account.view', 'identity.seller-access.view'],
      });
      expect(role.nameNormalized).toBe('night shift');
      expect(role.persistedVersion).toBeNull();
      expect(role.pendingEvents).toHaveLength(1);
      expect(role.pendingEvents[0]).toMatchObject({
        type: 'identity.role-created.v1',
        payload: {
          scope: 'platform',
          sellerId: null,
          addedKeys: ['identity.customer-account.view', 'identity.seller-access.view'],
          removedKeys: [],
        },
      });
      expect(JSON.stringify(role.pendingEvents)).not.toContain('Night');
    });

    it('keeps the seller of a seller-scope role and refuses a seller on a platform role (R9)', () => {
      expect(created({ scope: 'seller', sellerId: SELLER }).state.sellerId).toBe(SELLER);
      expect(() => created({ sellerId: SELLER })).toThrow(new RoleInvariantError('seller'));
      expect(() => created({ scope: 'seller', sellerId: null })).toThrow(
        new RoleInvariantError('seller'),
      );
    });

    it('refuses a malformed, repeated name or key, and a name on a seeded role', () => {
      expect(() => created({ name: '' })).toThrow(new RoleInvariantError('name'));
      expect(() => created({ name: ' padded ' })).toThrow(new RoleInvariantError('name'));
      expect(() => created({ permissionKeys: ['not a key'] })).toThrow(
        new RoleInvariantError('keys'),
      );
      expect(() =>
        created({ permissionKeys: ['identity.seller-access.view', 'identity.seller-access.view'] }),
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
        permissionKeys: ['identity.seller-access.view', 'identity.admin-account.view'],
        isDeclared: declared,
        now: NOW,
      });

      expect(edit.addedKeys).toEqual(['identity.admin-account.view']);
      expect(edit.removedKeys).toEqual(['identity.customer-account.view']);
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
        permissionKeys: ['identity.retired.key', 'identity.seller-access.view'],
      });
      const isDeclared = (key: string) => key !== 'identity.retired.key';

      const edit = stored.edit({
        name: 'Night shift',
        permissionKeys: ['identity.seller-access.view'],
        isDeclared,
        now: NOW,
      });
      const removed = stored.remove({ isDeclared, now: NOW });

      expect(edit.removedKeys).toEqual([]);
      expect(edit.renamed).toBe(false);
      expect(removed.pendingEvents[0]).toMatchObject({
        type: 'identity.role-deleted.v1',
        payload: { removedKeys: ['identity.seller-access.view'], addedKeys: [] },
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
