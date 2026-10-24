import { declarePermissions, definePermission } from '../../../platform/authz';

// The permission catalogue of notifications, pushed into the permission registry at bootstrap.
// A merchant's API key acts through the merchant system role, which holds every merchant key;
// operators through the platform roles that name the platform keys below.

/** Read the merchant's own webhook subscriptions. */
export const WEBHOOK_VIEW = definePermission('notifications', {
  key: 'notifications.webhook.view',
  scope: 'merchant',
  protected: false,
});

/** Subscribe, change, rotate the secret of and disable the merchant's own subscriptions. */
export const WEBHOOK_MANAGE = definePermission('notifications', {
  key: 'notifications.webhook.manage',
  scope: 'merchant',
  protected: false,
});

/** See dead-lettered webhook calls and send one again. */
export const WEBHOOK_CALL_RESEND = definePermission('notifications', {
  key: 'notifications.webhook-call.resend',
  scope: 'platform',
  protected: false,
});

/** Every permission notifications declares, for its module's registration. */
export const NOTIFICATIONS_PERMISSIONS = declarePermissions('notifications', [
  WEBHOOK_VIEW,
  WEBHOOK_MANAGE,
  WEBHOOK_CALL_RESEND,
]);
