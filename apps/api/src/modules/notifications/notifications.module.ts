import { Module } from '@nestjs/common';
import { registerJobsFrom } from '../../platform/scheduler/job-registry';
import {
  DisableWebhookSubscription,
  RotateWebhookSecret,
} from './application/use-cases/change-webhook-subscription.use-case';
import { DispatchSms } from './application/use-cases/dispatch-sms.use-case';
import { DispatchWebhooks } from './application/use-cases/dispatch-webhooks.use-case';
import { RecordDeliveryChange } from './application/use-cases/record-delivery-change.use-case';
import { ResendWebhookCall } from './application/use-cases/resend-webhook-call.use-case';
import { SubscribeToWebhooks } from './application/use-cases/subscribe-to-webhooks.use-case';
import { notificationsProviders } from './infrastructure/notifications-providers';
import { smsDispatchJob, webhookDispatchJob } from './presentation/jobs/notifications.jobs';

/**
 * Notifications: signed status webhooks to merchants and recipient SMS for delivery changes,
 * queued in PostgreSQL and sent with retries by two worker jobs. No route yet: subscription
 * management and the operator re-send are gated by identity (WP2) before they get one, and the
 * delivery outbox events are consumed once the delivery module publishes them (package 07).
 */
@Module({
  providers: [
    SubscribeToWebhooks,
    RotateWebhookSecret,
    DisableWebhookSubscription,
    RecordDeliveryChange,
    DispatchWebhooks,
    DispatchSms,
    ResendWebhookCall,
    ...notificationsProviders,
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
