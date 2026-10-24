import { Inject, Injectable } from '@nestjs/common';
import { ok, type Clock, type MarketContext } from '@mondapac-drive/shared-kernel';
import { CLOCK } from '../../../../platform/clock/clock.module';
import { UNIT_OF_WORK, type UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import {
  claim,
  exhaust,
  isExhausted,
  recordAttempt,
  type AttemptOutcome,
  type RetryPolicy,
} from '../../domain/outbound-message';
import {
  isAllowedRecipient,
  parsePhoneNumber,
  renderSms,
  smsRetryPolicy,
  type SmsSettings,
} from '../../domain/sms';
import {
  NOTIFICATION_SETTINGS,
  OUTBOUND_REPOSITORY,
  RECIPIENT_DIRECTORY,
  SMS_SENDER,
  TRACKING_LINKS,
  type NotificationSettingsProvider,
  type OutboundRepository,
  type RecipientDirectory,
  type SmsMessage,
  type SmsSender,
  type TrackingLinks,
} from '../ports';
import {
  DISPATCH_BATCH,
  INTERNAL_FAILURE,
  type DispatchSummary,
} from './dispatch-webhooks.use-case';

/** The longest a recipient or tracking lookup may take: well inside the claim lease. */
export const LOOKUP_TIMEOUT_MS = 5000;

function withinLookupTimeout<T>(lookup: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('notifications.lookup-timeout')), LOOKUP_TIMEOUT_MS);
  });
  return Promise.race([lookup, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Sends the due recipient SMS of one Market (the `notifications.sms-dispatch` job). The number
 * is read from the delivery at each attempt and only handed to the sender: it is never stored,
 * logged or put in an error. A missing tracking link is retried (tracking may issue it later);
 * a missing or malformed number dies at once.
 */
@Injectable()
export class DispatchSms {
  constructor(
    @Inject(OUTBOUND_REPOSITORY) private readonly outbound: OutboundRepository,
    @Inject(RECIPIENT_DIRECTORY) private readonly recipients: RecipientDirectory,
    @Inject(TRACKING_LINKS) private readonly tracking: TrackingLinks,
    @Inject(SMS_SENDER) private readonly sender: SmsSender,
    @Inject(NOTIFICATION_SETTINGS) private readonly settings: NotificationSettingsProvider,
    @Inject(UNIT_OF_WORK) private readonly unitOfWork: UnitOfWork,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async run(market: MarketContext): Promise<DispatchSummary> {
    const settings = this.settings.get(market.marketId).sms;
    const policy = smsRetryPolicy(settings);
    const claimed = await this.claimDue(market, policy);
    // One attempt that throws must not leave the others' outcomes unrecorded: they would be
    // sent again when their lease ends.
    const outcomes = await Promise.all(
      claimed.map(async (message) => ({
        message,
        outcome: await this.attempt(market, settings, message).catch(() => ({
          result: INTERNAL_FAILURE,
          providerMessageId: undefined,
        })),
      })),
    );
    let sent = 0;
    let dead = 0;
    for (const { message, outcome } of outcomes) {
      const next: SmsMessage = {
        ...message,
        ...recordAttempt(message, outcome.result, this.clock.now(), policy),
        providerMessageId: outcome.providerMessageId ?? message.providerMessageId,
      };
      try {
        await this.unitOfWork.run(market, async () =>
          ok(await this.outbound.saveSms(market, next, message.attempts)),
        );
      } catch {
        // Unrecorded, the SMS comes due after its lease and counts this attempt; at its last
        // attempt it is dead-lettered instead of being claimed again.
        continue;
      }
      if (next.status === 'sent') sent += 1;
      if (next.status === 'dead') dead += 1;
    }
    return { claimed: claimed.length, sent, dead };
  }

  private async claimDue(market: MarketContext, policy: RetryPolicy): Promise<SmsMessage[]> {
    const result = await this.unitOfWork.run(market, async () => {
      const now = this.clock.now();
      const taken: SmsMessage[] = [];
      for (const due of await this.outbound.dueSms(market, now, DISPATCH_BATCH)) {
        if (isExhausted(due, policy)) {
          await this.outbound.saveSms(market, { ...due, ...exhaust(due, now) }, due.attempts);
          continue;
        }
        const message = { ...due, ...claim(due, now) };
        if (await this.outbound.saveSms(market, message, due.attempts)) taken.push(message);
      }
      return ok(taken);
    });
    return result.ok ? result.value : [];
  }

  private async attempt(
    market: MarketContext,
    settings: SmsSettings,
    message: SmsMessage,
  ): Promise<{ result: AttemptOutcome; providerMessageId?: string }> {
    const raw = await withinLookupTimeout(this.recipients.phoneOf(market, message.deliveryId));
    const to = raw === undefined ? undefined : parsePhoneNumber(raw);
    if (to === undefined) {
      return { result: { sent: false, errorCode: 'sms.recipient-invalid', retryable: false } };
    }
    if (!isAllowedRecipient(settings, to)) {
      return { result: { sent: false, errorCode: 'sms.recipient-region', retryable: false } };
    }
    const text = renderSms(settings, message.kind, {
      reference: message.reference,
      trackingUrl: await withinLookupTimeout(this.tracking.linkFor(market, message.deliveryId)),
    });
    if (!text.ok) return { result: { sent: false, errorCode: text.error, retryable: true } };
    const sent = await this.sender.send(to, settings.senderId, text.value);
    return sent.ok
      ? { result: { sent: true }, providerMessageId: sent.providerMessageId }
      : { result: { sent: false, errorCode: sent.errorCode, retryable: sent.retryable } };
  }
}
