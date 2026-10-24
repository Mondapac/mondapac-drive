import type { SeededRole } from '../../application/ports/role-seed';

/**
 * The platform scope's roles (identity design 5.6): the Platform Administrator (the system role,
 * every platform key, the first admin of a Market receives it) and Drive's two default admin
 * roles. Each later module's work package adds its own keys to the default roles that need them
 * (R10). A default role never lists a protected key: merchants, API keys, admin accounts and
 * roles are the Platform Administrator's to manage, or a custom role's it grants.
 *
 * **A change of a role here raises its `seedVersion`.** The seed routine applies a newer version
 * to the stored row key by key, with an `identity.role.seed-applied` audit row; it never applies
 * an older one. No admin account is created by any seed (the first-admin routine owns it).
 */
export const PLATFORM_ROLES_SEED: readonly SeededRole[] = [
  {
    scope: 'platform',
    kind: 'system',
    seedCode: 'platform-administrator',
    seedVersion: 1,
    nameKey: 'identity.role.platform-administrator',
    permissionKeys: [],
  },
  {
    // Runs the operation day to day: sees merchants, couriers, admins and every delivery (with
    // the live map), and cancels a delivery on a merchant's behalf.
    scope: 'platform',
    kind: 'default',
    seedCode: 'operator',
    seedVersion: 3,
    nameKey: 'identity.role.operator',
    permissionKeys: [
      'identity.admin-account.view',
      'identity.platform-role.view',
      'identity.merchant.view',
      'identity.courier-account.view',
      'delivery.delivery.view',
      'delivery.delivery.cancel',
      'tracking.map.view',
      'dispatch.job.view',
    ],
  },
  {
    // Runs the fleet: onboards and disables couriers, opens dispatch, assigns and unassigns
    // couriers, watches them on the live map and the offers of each job, and cancels.
    scope: 'platform',
    kind: 'default',
    seedCode: 'dispatcher',
    seedVersion: 3,
    nameKey: 'identity.role.dispatcher',
    permissionKeys: [
      'identity.courier-account.view',
      'identity.courier-account.invite',
      'identity.courier-account.disable',
      'delivery.delivery.view',
      'delivery.delivery.dispatch',
      'delivery.delivery.cancel',
      'tracking.map.view',
      'dispatch.job.view',
      'dispatch.job.assign',
    ],
  },
];
