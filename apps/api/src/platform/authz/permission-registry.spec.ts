import { isFrozenKeySet } from './frozen-key-set';
import { declarePermissions, definePermission } from './permission';
import { PermissionRegistry, PermissionRegistryError } from './permission-registry';

// platform-foundations design 6.1, guarantees 1 to 5 of the PermissionRegistry (identity slice
// 8a-1), and the R-3 review note N-2 (the registry's sets are frozen).

const view = definePermission('identity', {
  key: 'identity.team-member.view',
  scope: 'seller',
  protected: false,
});
const invite = definePermission('identity', {
  key: 'identity.team-member.invite',
  scope: 'seller',
  protected: true,
});
const approve = definePermission('identity', {
  key: 'identity.seller-access.approve',
  scope: 'platform',
  protected: false,
});
const IDENTITY = declarePermissions('identity', [view, invite, approve]);
const SELLERS = declarePermissions('sellers', [
  definePermission('sellers', {
    key: 'sellers.business-identity.edit',
    scope: 'seller',
    protected: true,
  }),
]);

function sealed(retired: readonly string[] = []): PermissionRegistry {
  const registry = new PermissionRegistry(retired);
  registry.register('identity', IDENTITY);
  registry.register('sellers', SELLERS);
  registry.seal();
  return registry;
}

describe('PermissionRegistry', () => {
  describe('guarantee 1: modules push their declarations; boot fails on a bad one', () => {
    it('takes the catalogue of each module', () => {
      const registry = sealed();
      expect(registry.get('identity.team-member.view')).toEqual(view);
      expect(registry.get('sellers.business-identity.edit')).toMatchObject({ scope: 'seller' });
    });

    it('refuses a duplicate key, across modules or registrations', () => {
      const registry = new PermissionRegistry([]);
      registry.register('identity', IDENTITY);
      expect(() => registry.register('identity', IDENTITY)).toThrow(/registered twice/);
    });

    it('refuses a catalogue of another module, and a value declarePermissions did not make', () => {
      const registry = new PermissionRegistry([]);
      expect(() => registry.register('sellers', IDENTITY)).toThrow(PermissionRegistryError);
      expect(() =>
        registry.register('identity', { module: 'identity', declarations: [view] }),
      ).toThrow(/declarePermissions/);
    });

    it('checks each declaration again: a key changed after the catalogue was made is refused', () => {
      // A catalogue holds the objects it was given; one that was not made by definePermission
      // can still change, so the registry validates and copies every declaration itself.
      const mutable = { key: 'identity.team-member.edit', scope: 'seller', protected: false };
      const catalogue = declarePermissions('identity', [mutable as never]);
      mutable.key = 'sellers.offer.edit';
      expect(() => new PermissionRegistry([]).register('identity', catalogue)).toThrow(
        PermissionRegistryError,
      );
      mutable.key = 'identity.team-member.edit';
      const registry = new PermissionRegistry([]);
      registry.register('identity', catalogue);
      mutable.key = 'identity.team-member.delete';
      registry.seal();
      expect(registry.list().map((d) => d.key)).toEqual(['identity.team-member.edit']);
    });

    it('refuses a module name that is not a module name', () => {
      expect(() => new PermissionRegistry([]).register('Identity', IDENTITY)).toThrow(
        PermissionRegistryError,
      );
    });
  });

  describe('guarantee 2: sealed when bootstrap completes', () => {
    it('refuses register after sealing', () => {
      const registry = sealed();
      expect(() => registry.register('catalog', declarePermissions('catalog', []))).toThrow(
        /sealed/,
      );
    });

    it('refuses get, list, keysOf and the key lookup before sealing', () => {
      const registry = new PermissionRegistry([]);
      registry.register('identity', IDENTITY);
      expect(() => registry.get('identity.team-member.view')).toThrow(/not sealed/);
      expect(() => registry.list()).toThrow(/not sealed/);
      expect(() => registry.keysOf('seller')).toThrow(/not sealed/);
      expect(() => registry.isKnownPermissionKey('identity.team-member.view')).toThrow(
        /not sealed/,
      );
    });

    it('seals once, on application bootstrap', () => {
      const registry = new PermissionRegistry([]);
      registry.onApplicationBootstrap();
      expect(registry.sealed).toBe(true);
      expect(registry.list()).toEqual([]);
    });

    it('runs the checks registered for the sealed catalogue, and a failing one fails boot', () => {
      const registry = new PermissionRegistry([]);
      registry.register('identity', IDENTITY);
      const seen: number[] = [];
      registry.whenSealed((catalogue) => seen.push(catalogue.list().length));
      registry.whenSealed(() => {
        throw new Error('the seed names an unknown key');
      });
      expect(() => registry.seal()).toThrow(/unknown key/);
      expect(seen).toEqual([3]);
      expect(() => registry.whenSealed(() => undefined)).toThrow(/sealed/);
    });
  });

  describe('guarantee 3: an unknown key grants nothing', () => {
    it('answers undefined for an unknown key and leaves it out of every scope', () => {
      const registry = sealed();
      expect(registry.get('identity.team-member.delete')).toBeUndefined();
      expect(registry.keysOf('seller').has('identity.team-member.delete')).toBe(false);
    });
  });

  describe('guarantee 4: retired keys', () => {
    it('refuses to declare a retired key again', () => {
      const registry = new PermissionRegistry(['identity.team-member.view']);
      expect(() => registry.register('identity', IDENTITY)).toThrow(/retired/);
    });

    it('knows a retired key for payload fields, but never grants it', () => {
      const registry = sealed(['identity.team-member.old']);
      expect(registry.isKnownPermissionKey('identity.team-member.old')).toBe(true);
      expect(registry.isKnownPermissionKey('identity.team-member.view')).toBe(true);
      expect(registry.isKnownPermissionKey('identity.team-member.never')).toBe(false);
      expect(registry.get('identity.team-member.old')).toBeUndefined();
      expect(registry.keysOf('seller').has('identity.team-member.old')).toBe(false);
    });

    it('refuses a malformed entry of the retired list', () => {
      expect(() => new PermissionRegistry(['Not a key'])).toThrow(PermissionRegistryError);
    });
  });

  describe('guarantee 5: the code catalogue only', () => {
    it('lists by scope, sorted by key, and every declaration once', () => {
      const registry = sealed();
      expect(registry.list('seller').map((d) => d.key)).toEqual([
        'identity.team-member.invite',
        'identity.team-member.view',
        'sellers.business-identity.edit',
      ]);
      expect(registry.list('platform').map((d) => d.key)).toEqual([
        'identity.seller-access.approve',
      ]);
      expect(registry.list()).toHaveLength(4);
    });
  });

  describe('N-2: what it hands out is frozen', () => {
    it('answers frozen key sets and frozen lists', () => {
      const registry = sealed();
      const keys = registry.keysOf('seller');
      expect(isFrozenKeySet(keys)).toBe(true);
      expect(() => (keys as Set<string>).add('identity.role.edit')).toThrow(TypeError);
      expect(() => (keys as Set<string>).delete('identity.team-member.view')).toThrow(TypeError);
      expect(() => (keys as Set<string>).clear()).toThrow(TypeError);
      expect(registry.keysOf('seller').has('identity.role.edit')).toBe(false);
      expect(registry.keysOf('seller').size).toBe(3);
      expect(Object.isFrozen(registry.list())).toBe(true);
      expect(Object.isFrozen(registry.list('seller'))).toBe(true);
      expect(Object.isFrozen(registry.get('identity.team-member.view'))).toBe(true);
    });

    it('answers the same set on every call, so a check never rebuilds one', () => {
      const registry = sealed();
      expect(registry.keysOf('platform')).toBe(registry.keysOf('platform'));
    });
  });
});
