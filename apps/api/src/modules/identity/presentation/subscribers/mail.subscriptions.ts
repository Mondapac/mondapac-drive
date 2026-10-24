import {
  subscription,
  type RegisteredSubscription,
} from '../../../../platform/events/event-subscriptions';
import type { SendInvitationMail } from '../../application/use-cases/send-invitation-mail.use-case';
import type { SendLinkMail } from '../../application/use-cases/send-link-mail.use-case';
import type { SendOtherSessionsSignedOutMail } from '../../application/use-cases/send-other-sessions-signed-out-mail.use-case';
import type { SendPasswordChangedMail } from '../../application/use-cases/send-password-changed-mail.use-case';
import type { SendSecondFactorMail } from '../../application/use-cases/send-second-factor-mail.use-case';
import {
  AccountOtherSessionsSignedOut,
  AccountPasswordChanged,
  InvitationIssued,
  OneTimeLinkRequested,
  SecondFactorChanged,
} from '../../domain/events';

/** The subscriber names: also the `handler` of `identity.inbox` (data design 3.8). */
export const LINK_MAIL_SUBSCRIBER = 'identity.link-mail';
export const PASSWORD_CHANGED_MAIL_SUBSCRIBER = 'identity.password-changed-mail';
/** Profile package 4 (Hassan's follow-up): the notice after "sign out of all other devices". */
export const OTHER_SESSIONS_SIGNED_OUT_MAIL_SUBSCRIBER = 'identity.other-sessions-signed-out-mail';
/** Slice 7b: the invitation mail and the second-factor notice. */
export const INVITATION_MAIL_SUBSCRIBER = 'identity.invitation-mail';
export const SECOND_FACTOR_MAIL_SUBSCRIBER = 'identity.second-factor-mail';

/**
 * Identity's subscriptions to its own events for mail (identity design 8, 9; decided by Ali,
 * 14.1-6; slices 3 to 5). Each is an entry adapter: the dispatcher hands it the decoded event, the
 * delivery and the Market's system-actor context, which go unchanged to one `system` use case.
 * A refusal throws, so the delivery is retried and, after its last attempt, dead-lettered with
 * an alert (P 6.4).
 */
export function identityMailSubscriptions(
  sendLinkMail: SendLinkMail,
  sendPasswordChangedMail: SendPasswordChangedMail,
  sendInvitationMail: SendInvitationMail,
  sendSecondFactorMail: SendSecondFactorMail,
  sendOtherSessionsSignedOutMail: SendOtherSessionsSignedOutMail,
): RegisteredSubscription[] {
  return [
    subscription({
      name: LINK_MAIL_SUBSCRIBER,
      event: OneTimeLinkRequested,
      async handle(event, delivery, context) {
        const result = await sendLinkMail.execute(context, {
          delivery,
          linkId: event.payload.linkId,
          accountId: event.payload.accountId,
          purpose: event.payload.purpose,
          aggregateVersion: event.aggregateVersion,
        });
        if (!result.ok) throw new Error(`${LINK_MAIL_SUBSCRIBER} refused: ${result.error.code}`);
      },
    }),
    subscription({
      name: INVITATION_MAIL_SUBSCRIBER,
      event: InvitationIssued,
      async handle(event, delivery, context) {
        const result = await sendInvitationMail.execute(context, {
          delivery,
          invitationId: event.payload.invitationId,
          aggregateVersion: event.aggregateVersion,
        });
        if (!result.ok) {
          throw new Error(`${INVITATION_MAIL_SUBSCRIBER} refused: ${result.error.code}`);
        }
      },
    }),
    subscription({
      name: SECOND_FACTOR_MAIL_SUBSCRIBER,
      event: SecondFactorChanged,
      async handle(event, delivery, context) {
        const result = await sendSecondFactorMail.execute(context, {
          delivery,
          accountId: event.payload.accountId,
          change: event.payload.change,
          occurredAt: event.occurredAt,
        });
        if (!result.ok) {
          throw new Error(`${SECOND_FACTOR_MAIL_SUBSCRIBER} refused: ${result.error.code}`);
        }
      },
    }),
    subscription({
      name: PASSWORD_CHANGED_MAIL_SUBSCRIBER,
      event: AccountPasswordChanged,
      async handle(event, delivery, context) {
        const result = await sendPasswordChangedMail.execute(context, {
          delivery,
          accountId: event.payload.accountId,
          cause: event.payload.cause,
          occurredAt: event.occurredAt,
        });
        if (!result.ok) {
          throw new Error(`${PASSWORD_CHANGED_MAIL_SUBSCRIBER} refused: ${result.error.code}`);
        }
      },
    }),
    subscription({
      name: OTHER_SESSIONS_SIGNED_OUT_MAIL_SUBSCRIBER,
      event: AccountOtherSessionsSignedOut,
      async handle(event, delivery, context) {
        const result = await sendOtherSessionsSignedOutMail.execute(context, {
          delivery,
          accountId: event.payload.accountId,
          occurredAt: event.occurredAt,
        });
        if (!result.ok) {
          throw new Error(
            `${OTHER_SESSIONS_SIGNED_OUT_MAIL_SUBSCRIBER} refused: ${result.error.code}`,
          );
        }
      },
    }),
  ];
}
