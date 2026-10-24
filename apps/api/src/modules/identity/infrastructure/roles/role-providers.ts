import type { FactoryProvider } from '@nestjs/common';
import { PermissionRegistry } from '../../../../platform/authz';
import { PrismaService } from '../../../../platform/persistence/prisma.service';
import {
  EFFECTIVE_KEY_RESOLVER,
  effectiveKeysOf,
  registryView,
  type EffectiveKeyResolver,
} from '../../application/access/effective-keys';
import { ROLE_GRANT_READER, type RoleGrantReader } from '../../application/ports/role-grant-reader';
import {
  ROLE_ASSIGNMENT_REPOSITORY,
  ROLE_REPOSITORY,
  type RoleAssignmentRepository,
  type RoleRepository,
} from '../../application/ports/role.repository';
import { ROLE_SEED, type RoleSeed } from '../../application/ports/role-seed';
import { checkRoleSeedKeys } from '../../application/roles/role-seed-keys';
import { CheckedInRoleSeed } from '../seed/checked-in-role-seed';
import { PrismaRoleGrantReader } from './prisma-role-grant-reader';
import { PrismaRoleAssignmentRepository, PrismaRoleRepository } from './prisma-role.repository';

/** Token of the boot check of the seed's keys (identity design 5.6). */
export const ROLE_SEED_KEY_CHECK = Symbol('identity:role-seed-key-check');

/**
 * The roles and the permission path (identity design 5.2, 5.5, 5.6, 8.7):
 *
 * - the role and assignment repositories, and the checked-in role seed;
 * - the grant read, on identity's role tables (here because only `infrastructure/` may reach
 *   `PrismaService`);
 * - the one effective-key resolver of the process (R-3 review N-1): `effectiveKeysOf` over the
 *   permission registry, which the `AuthorisationCheck` and the actor summary inject through `EFFECTIVE_KEY_RESOLVER`;
 * - the boot check of the seed's keys: once the registry is sealed, a seed key that is unknown,
 *   of the wrong scope or protected fails boot, in both roles.
 */
export const roleProviders: readonly FactoryProvider[] = [
  {
    provide: ROLE_REPOSITORY,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): RoleRepository => new PrismaRoleRepository(prisma),
  },
  {
    provide: ROLE_ASSIGNMENT_REPOSITORY,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): RoleAssignmentRepository =>
      new PrismaRoleAssignmentRepository(prisma),
  },
  {
    // The checked-in seed, checked at boot (identity design 5.6).
    provide: ROLE_SEED,
    useFactory: (): RoleSeed => new CheckedInRoleSeed(),
  },
  {
    provide: ROLE_GRANT_READER,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): RoleGrantReader => new PrismaRoleGrantReader(prisma),
  },
  {
    provide: EFFECTIVE_KEY_RESOLVER,
    inject: [PermissionRegistry],
    useFactory: (registry: PermissionRegistry): EffectiveKeyResolver => {
      const view = registryView(registry);
      return Object.freeze((subject: Parameters<EffectiveKeyResolver>[0]) =>
        effectiveKeysOf(subject, view),
      );
    },
  },
  {
    provide: ROLE_SEED_KEY_CHECK,
    inject: [PermissionRegistry, ROLE_SEED],
    useFactory: (registry: PermissionRegistry, seed: RoleSeed) => {
      registry.whenSealed((catalogue) => checkRoleSeedKeys(seed.roles(), catalogue));
      return 'identity.role-seed-keys';
    },
  },
];
