import {
  subscription,
  type RegisteredSubscription,
} from '../../../../platform/events/event-subscriptions';
import type { ForgetPushDevices } from '../../application/use-cases/push-devices.use-case';
import type { SendOfferPush } from '../../application/use-cases/send-offer-push.use-case';
import {
  DISPATCH_OFFER_SENT,
  IDENTITY_ACCOUNT_DISABLED,
  IDENTITY_OTHER_SESSIONS_SIGNED_OUT,
  IDENTITY_PASSWORD_CHANGED,
} from './consumed-events';

/** The subscriber names: also the `handler` of `notifications.inbox`. */
export const OFFER_PUSH_SUBSCRIBER = 'notifications.offer-push';
export const ACCOUNT_DISABLED_SUBSCRIBER = 'notifications.disabled-account-sessions';
export const PASSWORD_CHANGED_SUBSCRIBER = 'notifications.password-changed-sessions';
export const OTHER_SESSIONS_SUBSCRIBER = 'notifications.signed-out-sessions';

/**
 * Notifications' subscriptions for courier push (handoff 33): a sent offer is pushed to the
 * courier's devices, and identity's ends of sessions drop the account's devices. Each hands the
 * event, the delivery and the Market's system context to one `system` use case; a refusal
 * throws, so the delivery is retried through the inbox and, after its last attempt,
 * dead-lettered.
 */
export function pushSubscriptions(
  sendOfferPush: SendOfferPush,
  forgetDevices: ForgetPushDevices,
): RegisteredSubscription[] {
  const refused = (name: string, code: string) => new Error(`${name} refused: ${code}`);
  const forget =
    (name: string) =>
    async (
      event: { readonly payload: { readonly accountId: string } },
      delivery: Parameters<RegisteredSubscription['handle']>[1],
      context: Parameters<RegisteredSubscription['handle']>[2],
    ) => {
      const result = await forgetDevices.execute(context, {
        delivery,
        accountId: event.payload.accountId,
      });
      if (!result.ok) throw refused(name, result.error.code);
    };
  return [
    subscription({
      name: OFFER_PUSH_SUBSCRIBER,
      event: DISPATCH_OFFER_SENT,
      async handle(event, delivery, context) {
        const result = await sendOfferPush.execute(context, {
          delivery,
          offerId: event.aggregateId,
          courierId: event.payload.courierId,
          expiresAt: event.payload.expiresAt,
        });
        if (!result.ok) throw refused(OFFER_PUSH_SUBSCRIBER, result.error.code);
      },
    }),
    subscription({
      name: ACCOUNT_DISABLED_SUBSCRIBER,
      event: IDENTITY_ACCOUNT_DISABLED,
      handle: forget(ACCOUNT_DISABLED_SUBSCRIBER),
    }),
    subscription({
      name: PASSWORD_CHANGED_SUBSCRIBER,
      event: IDENTITY_PASSWORD_CHANGED,
      handle: forget(PASSWORD_CHANGED_SUBSCRIBER),
    }),
    subscription({
      name: OTHER_SESSIONS_SUBSCRIBER,
      event: IDENTITY_OTHER_SESSIONS_SIGNED_OUT,
      handle: forget(OTHER_SESSIONS_SUBSCRIBER),
    }),
  ];
}
