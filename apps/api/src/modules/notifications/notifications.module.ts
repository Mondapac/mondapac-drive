import { Module, type FactoryProvider } from '@nestjs/common';
import type { Clock, IdGenerator } from '@mondapac-drive/shared-kernel';
import { registerAuditActions } from '../../platform/audit/audit-action-catalogue';
import { AUDIT_WRITER, type AuditWriter } from '../../platform/audit/audit-writer';
import { registerPermissions, USE_CASE_GATE, type UseCaseGate } from '../../platform/authz';
import { CLOCK } from '../../platform/clock/clock.module';
import { registerSubscriptionsFrom } from '../../platform/events/event-subscriptions';
import { ID_GENERATOR } from '../../platform/ids/ids.module';
import { PersistenceModule } from '../../platform/persistence/persistence.module';
import { registerJobsFrom } from '../../platform/scheduler/job-registry';
import { UNIT_OF_WORK, type UnitOfWork } from '../../platform/unit-of-work/unit-of-work';
import { DeliveryModule } from '../delivery';
import { TrackingModule } from '../tracking';
import {
  DELIVERY_CONTACTS,
  NOTIFICATION_SETTINGS,
  OUTBOUND_REPOSITORY,
  SMS_SENDER,
  TRACKING_LINKS,
  WEBHOOK_SIGNER,
  WEBHOOK_SUBSCRIPTIONS,
  WEBHOOK_TRANSPORT,
  type DeliveryContacts,
  type NotificationSettingsProvider,
  type OutboundRepository,
  type SmsSender,
  type TrackingLinks,
  type WebhookSigner,
  type WebhookSubscriptionRepository,
  type WebhookTransport,
} from './application/ports';
import {
  ChangeWebhookEventTypes,
  DisableWebhookSubscription,
  ListWebhookSubscriptions,
  RotateWebhookSecret,
} from './application/use-cases/change-webhook-subscription.use-case';
import { DispatchSms } from './application/use-cases/dispatch-sms.use-case';
import { DispatchWebhooks } from './application/use-cases/dispatch-webhooks.use-case';
import { RecordDeliveryChange } from './application/use-cases/record-delivery-change.use-case';
import {
  ListDeadWebhookCalls,
  ResendWebhookCall,
} from './application/use-cases/resend-webhook-call.use-case';
import { SubscribeToWebhooks } from './application/use-cases/subscribe-to-webhooks.use-case';
import { NOTIFICATIONS_PERMISSIONS } from './contracts/permissions';
import { NOTIFICATIONS_AUDIT_ACTIONS } from './domain/audit';
import { notificationsProviders } from './infrastructure/notifications-providers';
import { smsDispatchJob, webhookDispatchJob } from './presentation/jobs/notifications.jobs';
import {
  AdminWebhookCallController,
  MerchantWebhookController,
} from './presentation/notifications.controller';
import { deliveryChangeSubscriptions } from './presentation/subscribers/delivery-change.subscriptions';

/** A merchant's change of its own subscription: the gate, the store, the signer, the audit. */
function subscriptionChange<U>(
  type: new (
    gate: UseCaseGate,
    deps: {
      subscriptions: WebhookSubscriptionRepository;
      signer: WebhookSigner;
      settings: NotificationSettingsProvider;
      audit: AuditWriter;
      unitOfWork: UnitOfWork;
      clock: Clock;
    },
  ) => U,
): FactoryProvider<U> {
  return {
    provide: type,
    inject: [
      USE_CASE_GATE,
      WEBHOOK_SUBSCRIPTIONS,
      WEBHOOK_SIGNER,
      NOTIFICATION_SETTINGS,
      AUDIT_WRITER,
      UNIT_OF_WORK,
      CLOCK,
    ],
    useFactory: (
      gate: UseCaseGate,
      subscriptions: WebhookSubscriptionRepository,
      signer: WebhookSigner,
      settings: NotificationSettingsProvider,
      audit: AuditWriter,
      unitOfWork: UnitOfWork,
      clock: Clock,
    ) => new type(gate, { subscriptions, signer, settings, audit, unitOfWork, clock }),
  };
}

/**
 * Notifications: signed status webhooks to merchants and recipient SMS for delivery changes,
 * queued in PostgreSQL from the delivery events and sent with retries by two worker jobs. Every
 * entry is a use case behind the UseCaseGate: the subscriptions and jobs run as the Market's
 * system actor, a merchant manages its own webhook subscriptions with its API key, and an
 * operator re-sends a dead-lettered call. Changes are audited.
 */
@Module({
  imports: [DeliveryModule, TrackingModule],
  controllers: [MerchantWebhookController, AdminWebhookCallController],
  providers: [
    registerPermissions('notifications', NOTIFICATIONS_PERMISSIONS),
    PersistenceModule.auditWriterFor('notifications'),
    registerAuditActions('notifications', NOTIFICATIONS_AUDIT_ACTIONS),
    ...notificationsProviders,
    {
      provide: SubscribeToWebhooks,
      inject: [
        USE_CASE_GATE,
        WEBHOOK_SUBSCRIPTIONS,
        WEBHOOK_SIGNER,
        AUDIT_WRITER,
        UNIT_OF_WORK,
        ID_GENERATOR,
        CLOCK,
      ],
      useFactory: (
        gate: UseCaseGate,
        subscriptions: WebhookSubscriptionRepository,
        signer: WebhookSigner,
        audit: AuditWriter,
        unitOfWork: UnitOfWork,
        ids: IdGenerator,
        clock: Clock,
      ) => new SubscribeToWebhooks(gate, { subscriptions, signer, audit, unitOfWork, ids, clock }),
    },
    subscriptionChange(RotateWebhookSecret),
    subscriptionChange(ChangeWebhookEventTypes),
    subscriptionChange(DisableWebhookSubscription),
    {
      provide: ListWebhookSubscriptions,
      inject: [USE_CASE_GATE, WEBHOOK_SUBSCRIPTIONS, UNIT_OF_WORK],
      useFactory: (
        gate: UseCaseGate,
        subscriptions: WebhookSubscriptionRepository,
        unitOfWork: UnitOfWork,
      ) => new ListWebhookSubscriptions(gate, { subscriptions, unitOfWork }),
    },
    {
      provide: RecordDeliveryChange,
      inject: [
        USE_CASE_GATE,
        DELIVERY_CONTACTS,
        WEBHOOK_SUBSCRIPTIONS,
        OUTBOUND_REPOSITORY,
        UNIT_OF_WORK,
        ID_GENERATOR,
        CLOCK,
      ],
      useFactory: (
        gate: UseCaseGate,
        contacts: DeliveryContacts,
        subscriptions: WebhookSubscriptionRepository,
        outbound: OutboundRepository,
        unitOfWork: UnitOfWork,
        ids: IdGenerator,
        clock: Clock,
      ) =>
        new RecordDeliveryChange(gate, {
          contacts,
          subscriptions,
          outbound,
          unitOfWork,
          ids,
          clock,
        }),
    },
    {
      provide: DispatchWebhooks,
      inject: [
        USE_CASE_GATE,
        OUTBOUND_REPOSITORY,
        WEBHOOK_SUBSCRIPTIONS,
        WEBHOOK_SIGNER,
        WEBHOOK_TRANSPORT,
        NOTIFICATION_SETTINGS,
        UNIT_OF_WORK,
        CLOCK,
      ],
      useFactory: (
        gate: UseCaseGate,
        outbound: OutboundRepository,
        subscriptions: WebhookSubscriptionRepository,
        signer: WebhookSigner,
        transport: WebhookTransport,
        settings: NotificationSettingsProvider,
        unitOfWork: UnitOfWork,
        clock: Clock,
      ) =>
        new DispatchWebhooks(gate, {
          outbound,
          subscriptions,
          signer,
          transport,
          settings,
          unitOfWork,
          clock,
        }),
    },
    {
      provide: DispatchSms,
      inject: [
        USE_CASE_GATE,
        OUTBOUND_REPOSITORY,
        DELIVERY_CONTACTS,
        TRACKING_LINKS,
        SMS_SENDER,
        NOTIFICATION_SETTINGS,
        UNIT_OF_WORK,
        CLOCK,
      ],
      useFactory: (
        gate: UseCaseGate,
        outbound: OutboundRepository,
        contacts: DeliveryContacts,
        tracking: TrackingLinks,
        sender: SmsSender,
        settings: NotificationSettingsProvider,
        unitOfWork: UnitOfWork,
        clock: Clock,
      ) =>
        new DispatchSms(gate, {
          outbound,
          contacts,
          tracking,
          sender,
          settings,
          unitOfWork,
          clock,
        }),
    },
    {
      provide: ResendWebhookCall,
      inject: [USE_CASE_GATE, OUTBOUND_REPOSITORY, AUDIT_WRITER, UNIT_OF_WORK, CLOCK],
      useFactory: (
        gate: UseCaseGate,
        outbound: OutboundRepository,
        audit: AuditWriter,
        unitOfWork: UnitOfWork,
        clock: Clock,
      ) => new ResendWebhookCall(gate, { outbound, audit, unitOfWork, clock }),
    },
    {
      provide: ListDeadWebhookCalls,
      inject: [USE_CASE_GATE, OUTBOUND_REPOSITORY, UNIT_OF_WORK],
      useFactory: (gate: UseCaseGate, outbound: OutboundRepository, unitOfWork: UnitOfWork) =>
        new ListDeadWebhookCalls(gate, { outbound, unitOfWork }),
    },
    registerSubscriptionsFrom(
      'notifications',
      [RecordDeliveryChange],
      (record: RecordDeliveryChange) => deliveryChangeSubscriptions(record),
    ),
    registerJobsFrom(
      'notifications',
      [DispatchWebhooks, DispatchSms],
      (webhooks: DispatchWebhooks, sms: DispatchSms) => [
        webhookDispatchJob(webhooks),
        smsDispatchJob(sms),
      ],
    ),
  ],
})
export class NotificationsModule {}
