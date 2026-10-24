import { auditField, defineAuditAction } from '@mondapac-drive/shared-kernel';
import type { AuditActionDefinition } from '@mondapac-drive/shared-kernel';
import { WEBHOOK_EVENT_TYPES } from './delivery-change';

// The audited actions of notifications, registered at boot with
// `registerAuditActions('notifications', NOTIFICATIONS_AUDIT_ACTIONS)` and written through the
// module's own AUDIT_WRITER in the unit of the change. Ids, codes, counts and instants only:
// never a URL (it may carry a merchant's own token), a secret or a phone number.

const eventTypes = auditField.listOf(auditField.enumOf(WEBHOOK_EVENT_TYPES), 3);
const TARGET = 'notifications.webhook-subscription';

/** A merchant subscribed an endpoint. Target: the subscription. */
export const WebhookSubscribedAudit = defineAuditAction({
  action: 'notifications.webhook-subscription.created',
  targetType: TARGET,
  actors: ['authenticated'],
  after: { eventTypes, secretVersion: auditField.integer() },
});

/** A merchant changed the event types of a subscription. */
export const WebhookEventTypesChangedAudit = defineAuditAction({
  action: 'notifications.webhook-subscription.event-types-changed',
  targetType: TARGET,
  actors: ['authenticated'],
  before: { eventTypes },
  after: { eventTypes },
});

/** A merchant rotated a subscription's secret; the previous one signs until the instant given. */
export const WebhookSecretRotatedAudit = defineAuditAction({
  action: 'notifications.webhook-subscription.secret-rotated',
  targetType: TARGET,
  actors: ['authenticated'],
  before: { secretVersion: auditField.integer() },
  after: {
    secretVersion: auditField.integer(),
    previousSecretValidUntil: auditField.optional(auditField.instant()),
  },
});

/** A merchant disabled a subscription. */
export const WebhookDisabledAudit = defineAuditAction({
  action: 'notifications.webhook-subscription.disabled',
  targetType: TARGET,
  actors: ['authenticated'],
  after: { disabled: auditField.boolean() },
});

/** An operator sent a dead-lettered webhook call again. Target: the call. */
export const WebhookCallResentAudit = defineAuditAction({
  action: 'notifications.webhook-call.resent',
  targetType: 'notifications.webhook-call',
  actors: ['authenticated'],
  before: { attempts: auditField.integer() },
  after: { subscriptionId: auditField.id() },
});

export const NOTIFICATIONS_AUDIT_ACTIONS: readonly AuditActionDefinition[] = [
  WebhookSubscribedAudit,
  WebhookEventTypesChangedAudit,
  WebhookSecretRotatedAudit,
  WebhookDisabledAudit,
  WebhookCallResentAudit,
];
