import type { SeededRole } from '../../application/ports/role-seed';

/**
 * The merchant and courier scopes' roles (identity design 5.6): one system role each, founded
 * with the account (a merchant's integration account when the merchant is created, a courier's
 * account when it accepts its invitation) and never granted. A system role stores no key: it
 * holds every key its scope declares, so a module that adds a merchant or courier key needs no
 * seed change.
 */
export const POPULATION_ROLES_SEED: readonly SeededRole[] = [
  {
    scope: 'merchant',
    kind: 'system',
    seedCode: 'merchant',
    seedVersion: 1,
    nameKey: 'identity.role.merchant',
    permissionKeys: [],
  },
  {
    scope: 'courier',
    kind: 'system',
    seedCode: 'courier',
    seedVersion: 1,
    nameKey: 'identity.role.courier',
    permissionKeys: [],
  },
];
