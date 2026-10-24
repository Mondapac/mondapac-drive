import {
  declarePermissions,
  definePermission,
  isPermissionCatalogue,
  MAX_PERMISSION_KEY_LENGTH,
  PermissionDeclarationError,
} from './permission';

// platform-foundations design 6.1: one helper validates and brands the keys of a module.

describe('definePermission', () => {
  it('brands a key of the declaring module, with its scope and protection', () => {
    expect(
      definePermission('identity', {
        key: 'identity.seller-access.view',
        scope: 'platform',
        protected: false,
      }),
    ).toEqual({ key: 'identity.seller-access.view', scope: 'platform', protected: false });
  });

  it.each([
    ['a key of another module', { key: 'sellers.offer.edit', scope: 'seller', protected: false }],
    ['two segments', { key: 'identity.view', scope: 'platform', protected: false }],
    ['upper case', { key: 'identity.Seller.view', scope: 'platform', protected: false }],
    ['a customer scope', { key: 'identity.order.view', scope: 'customer', protected: false }],
    ['no protection stated', { key: 'identity.order.view', scope: 'platform' }],
    [
      'a key longer than MAX_PERMISSION_KEY_LENGTH',
      {
        key: `identity.${'a'.repeat(MAX_PERMISSION_KEY_LENGTH - 'identity..view'.length + 1)}.view`,
        scope: 'platform',
        protected: false,
      },
    ],
  ])('refuses %s', (_case, declaration) => {
    expect(() => definePermission('identity', declaration as never)).toThrow(
      PermissionDeclarationError,
    );
  });
});

describe('the key length cap: the stored column limit of 128 (slice 8a-1; Ali on Mohammad)', () => {
  it('accepts a key of exactly MAX_PERMISSION_KEY_LENGTH characters', () => {
    const key = `identity.${'a'.repeat(MAX_PERMISSION_KEY_LENGTH - 'identity..view'.length)}.view`;
    expect(key).toHaveLength(MAX_PERMISSION_KEY_LENGTH);
    expect(definePermission('identity', { key, scope: 'platform', protected: false }).key).toBe(
      key,
    );
  });
});

describe('declarePermissions', () => {
  const view = definePermission('identity', {
    key: 'identity.team-member.view',
    scope: 'seller',
    protected: false,
  });

  it('makes a catalogue the CI check can recognise, and nothing else is one', () => {
    const catalogue = declarePermissions('identity', [view]);

    expect(isPermissionCatalogue(catalogue)).toBe(true);
    expect(isPermissionCatalogue({ ...catalogue })).toBe(false);
    expect(catalogue.declarations).toEqual([view]);
    expect(Object.isFrozen(catalogue)).toBe(true);
  });

  it('refuses a duplicate key and a declaration of another module', () => {
    expect(() => declarePermissions('identity', [view, view])).toThrow(/twice/);
    expect(() => declarePermissions('sellers', [view])).toThrow(PermissionDeclarationError);
  });
});
