import { Temporal } from '@mondapac-drive/shared-kernel';
import type { JobDefinition } from '../../../../platform/scheduler/job-registry';
import type { DispatchSms } from '../../application/use-cases/dispatch-sms.use-case';
import type { DispatchWebhooks } from '../../application/use-cases/dispatch-webhooks.use-case';

/** Sends due merchant webhooks, every 10 s per Market. */
export function webhookDispatchJob(dispatch: DispatchWebhooks): JobDefinition {
  return {
    name: 'notifications.webhook-dispatch',
    every: Temporal.Duration.from({ seconds: 10 }),
    run: async (context) => {
      await dispatch.run(context.market);
    },
  };
}

/** Sends due recipient SMS, every 10 s per Market. */
export function smsDispatchJob(dispatch: DispatchSms): JobDefinition {
  return {
    name: 'notifications.sms-dispatch',
    every: Temporal.Duration.from({ seconds: 10 }),
    run: async (context) => {
      await dispatch.run(context.market);
    },
  };
}
