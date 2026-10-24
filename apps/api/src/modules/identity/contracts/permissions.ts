import { declarePermissions, definePermission } from '../../../platform/authz';

// The permission catalogue of identity (identity design 5.3; platform-foundations 6.1), pushed
// into the permission registry at bootstrap. Labels are translation keys derived from the key.
// `protected` is R11: a protected key may be put in a role, or a role holding one assigned or
// invited, only by a holder of the Platform Administrator role. Drive's identity keys are all
// platform scope: merchants and couriers act through their own system roles, which hold every
// key of their scope (delivery's, tracking's, ...), and manage no team.
// Non-default verbs (5.1, I9): suspend, disable, invite, assign, issue, revoke,
// reset-second-factor.

const platform = (key: string, isProtected: boolean) =>
  definePermission('identity', { key, scope: 'platform', protected: isProtected });

/** List admin accounts, their roles and open invitations. */
export const ADMIN_ACCOUNT_VIEW = platform('identity.admin-account.view', false);
/** Invite an admin; re-send or revoke. */
export const ADMIN_ACCOUNT_INVITE = platform('identity.admin-account.invite', true);
/** Disable and re-enable an admin account. */
export const ADMIN_ACCOUNT_DISABLE = platform('identity.admin-account.disable', true);
/** Reset another admin's second factor. */
export const ADMIN_ACCOUNT_RESET_SECOND_FACTOR = platform(
  'identity.admin-account.reset-second-factor',
  true,
);
/** See roles and their permissions (admin panel). */
export const PLATFORM_ROLE_VIEW = platform('identity.platform-role.view', false);
/** The role editor of the admin panel. */
export const PLATFORM_ROLE_CREATE = platform('identity.platform-role.create', true);
export const PLATFORM_ROLE_EDIT = platform('identity.platform-role.edit', true);
export const PLATFORM_ROLE_DELETE = platform('identity.platform-role.delete', true);
/** Change an admin's role. */
export const PLATFORM_ROLE_ASSIGN = platform('identity.platform-role.assign', true);

/** List courier accounts and open courier invitations. */
export const COURIER_ACCOUNT_VIEW = platform('identity.courier-account.view', false);
/** Invite a courier; re-send or revoke the invitation (the dispatcher onboards couriers). */
export const COURIER_ACCOUNT_INVITE = platform('identity.courier-account.invite', false);
/** Disable and re-enable a courier account; disabling signs the courier out everywhere. */
export const COURIER_ACCOUNT_DISABLE = platform('identity.courier-account.disable', false);

/** List merchants and their API keys (never a key's secret). */
export const MERCHANT_VIEW = platform('identity.merchant.view', false);
/** Create a merchant (the business that books deliveries through the API). */
export const MERCHANT_CREATE = platform('identity.merchant.create', true);
/** Suspend and reinstate a merchant; suspending revokes every key at once. */
export const MERCHANT_SUSPEND = platform('identity.merchant.suspend', true);
/** Issue and revoke a merchant's API keys. Protected: a key acts for the merchant. */
export const MERCHANT_API_KEY_ISSUE = platform('identity.merchant-api-key.issue', true);

/** Every permission identity declares, for its module's registration. */
export const IDENTITY_PERMISSIONS = declarePermissions('identity', [
  ADMIN_ACCOUNT_VIEW,
  ADMIN_ACCOUNT_INVITE,
  ADMIN_ACCOUNT_DISABLE,
  ADMIN_ACCOUNT_RESET_SECOND_FACTOR,
  PLATFORM_ROLE_VIEW,
  PLATFORM_ROLE_CREATE,
  PLATFORM_ROLE_EDIT,
  PLATFORM_ROLE_DELETE,
  PLATFORM_ROLE_ASSIGN,
  COURIER_ACCOUNT_VIEW,
  COURIER_ACCOUNT_INVITE,
  COURIER_ACCOUNT_DISABLE,
  MERCHANT_VIEW,
  MERCHANT_CREATE,
  MERCHANT_SUSPEND,
  MERCHANT_API_KEY_ISSUE,
]);
