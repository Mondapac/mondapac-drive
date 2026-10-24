import { Temporal } from '@mondapac-drive/shared-kernel';
import type { JobDefinition } from '../../../../platform/scheduler/job-registry';
import type { DispatchSms } from '../../application/use-cases/dispatch-sms.use-case';
import type { DispatchWebhooks } from '../../application/use-cases/dispatch-webhooks.use-case';

/** Sends due merchant webhooks, every 10 s per Market, as the Market's system actor. */
export function webhookDispatchJob(dispatch: DispatchWebhooks): JobDefinition {
  return {
    name: 'notifications.webhook-dispatch',
    every: Temporal.Duration.from({ seconds: 10 }),
    run: async (context) => {
      const result = await dispatch.execute(context, {});
      if (!result.ok)
        throw new Error(`notifications.webhook-dispatch refused: ${result.error.code}`);
    },
  };
}

/** Sends due recipient SMS, every 10 s per Market, as the Market's system actor. */
export function smsDispatchJob(dispatch: DispatchSms): JobDefinition {
  return {
    name: 'notifications.sms-dispatch',
    every: Temporal.Duration.from({ seconds: 10 }),
    run: async (context) => {
      const result = await dispatch.execute(context, {});
      if (!result.ok) throw new Error(`notifications.sms-dispatch refused: ${result.error.code}`);
    },
  };
}
