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
    // the live map), cancels a delivery on a merchant's behalf, re-sends a dead webhook call to a
    // merchant and sees merchants' webhook subscriptions (never a secret), and reads courier
    // payout lines and balances (never records or settles money).
    scope: 'platform',
    kind: 'default',
    seedCode: 'operator',
    seedVersion: 6,
    nameKey: 'identity.role.operator',
    permissionKeys: [
      'identity.admin-account.view',
      'identity.platform-role.view',
      'identity.merchant.view',
      'identity.courier-account.view',
      'delivery.delivery.view',
      'delivery.delivery.cancel',
      'tracking.map.view',
      'fleet.courier.view',
      'dispatch.job.view',
      'notifications.webhook-call.resend',
      'payouts.ledger.view',
      'notifications.webhook-subscription.view',
    ],
  },
  {
    // Runs the fleet: onboards and disables couriers (approves, reviews their documents and
    // vehicles, suspends and offboards them), opens dispatch, assigns and unassigns
    // couriers, watches them on the live map and the offers of each job, and cancels.
    scope: 'platform',
    kind: 'default',
    seedCode: 'dispatcher',
    seedVersion: 4,
    nameKey: 'identity.role.dispatcher',
    permissionKeys: [
      'identity.courier-account.view',
      'identity.courier-account.invite',
      'identity.courier-account.disable',
      'delivery.delivery.view',
      'delivery.delivery.dispatch',
      'delivery.delivery.cancel',
      'tracking.map.view',
      'fleet.courier.view',
      'fleet.courier.decide',
      'fleet.document.review',
      'fleet.vehicle.manage',
      'dispatch.job.view',
      'dispatch.job.assign',
    ],
  },
];
