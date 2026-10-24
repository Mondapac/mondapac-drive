import {
  err,
  ok,
  type CallContext,
  type Clock,
  type MarketContext,
  type Result,
} from '@mondapac-drive/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
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
  trackingUrlFor,
  type SmsSettings,
} from '../../domain/sms';
import { ACCESS_DENIED, isSystem } from '../callers';
import type { NotificationsFailure } from '../failure';
import type {
  DeliveryContacts,
  NotificationSettingsProvider,
  OutboundRepository,
  SmsMessage,
  SmsSender,
  TrackingLinks,
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

export interface DispatchSmsDependencies {
  readonly outbound: OutboundRepository;
  readonly contacts: DeliveryContacts;
  readonly tracking: TrackingLinks;
  readonly sender: SmsSender;
  readonly settings: NotificationSettingsProvider;
  readonly unitOfWork: UnitOfWork;
  readonly clock: Clock;
}

/**
 * Sends the due recipient SMS of one Market (the `notifications.sms-dispatch` job, rule
 * `system`). The number and, for the booked message, the proof-of-delivery PIN are read from
 * the delivery at each attempt and only handed to the sender: they are never stored, logged or
 * put in an error. A template that shows the tracking link gets a fresh link from tracking at
 * the attempt; while tracking cannot issue one the SMS is retried. A missing or malformed
 * number dies at once.
 */
export class DispatchSms extends UseCase<
  Record<string, never>,
  DispatchSummary,
  NotificationsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'notifications.dispatch-sms',
    rule: { kind: 'system' },
  };

  private readonly outbound: OutboundRepository;
  private readonly contacts: DeliveryContacts;
  private readonly tracking: TrackingLinks;
  private readonly sender: SmsSender;
  private readonly settings: NotificationSettingsProvider;
  private readonly unitOfWork: UnitOfWork;
  private readonly clock: Clock;

  constructor(gate: UseCaseGate, deps: DispatchSmsDependencies) {
    super(gate);
    this.outbound = deps.outbound;
    this.contacts = deps.contacts;
    this.tracking = deps.tracking;
    this.sender = deps.sender;
    this.settings = deps.settings;
    this.unitOfWork = deps.unitOfWork;
    this.clock = deps.clock;
  }

  protected async handle(
    context: CallContext,
  ): Promise<Result<DispatchSummary, NotificationsFailure>> {
    if (!isSystem(context)) return err(ACCESS_DENIED);
    const { market } = context;
    const settings = this.settings.get(market.marketId).sms;
    const policy = smsRetryPolicy(settings);
    const claimed = await this.claimDue(market, policy);
    // One attempt that throws must not leave the others' outcomes unrecorded: they would be
    // sent again when their lease ends.
    const outcomes = await Promise.all(
      claimed.map(async (message) => ({
        message,
        outcome: await this.attempt(context, settings, message).catch(() => ({
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
    return ok({ claimed: claimed.length, sent, dead });
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
    context: CallContext,
    settings: SmsSettings,
    message: SmsMessage,
  ): Promise<{ result: AttemptOutcome; providerMessageId?: string }> {
    const contact = await withinLookupTimeout(this.contacts.contactOf(context, message.deliveryId));
    const raw = contact?.dropoffPhone ?? undefined;
    const to = raw === undefined ? undefined : parsePhoneNumber(raw);
    if (to === undefined) {
      return { result: { sent: false, errorCode: 'sms.recipient-invalid', retryable: false } };
    }
    if (!isAllowedRecipient(settings, to)) {
      return { result: { sent: false, errorCode: 'sms.recipient-region', retryable: false } };
    }
    const token = settings.templates[message.kind].includes('{trackingUrl}')
      ? await withinLookupTimeout(this.tracking.issue(context, message.deliveryId))
      : undefined;
    const pin = message.kind === 'booked' ? (contact?.recipientPin ?? undefined) : undefined;
    const text = renderSms(settings, message.kind, {
      reference: message.reference,
      ...(token === undefined ? {} : { trackingUrl: trackingUrlFor(settings, token) }),
      ...(pin === undefined ? {} : { pin }),
    });
    if (!text.ok) {
      return {
        result: { sent: false, errorCode: text.error, retryable: text.error !== 'sms.pin-invalid' },
      };
    }
    const sent = await this.sender.send(to, settings.senderId, text.value);
    return sent.ok
      ? { result: { sent: true }, providerMessageId: sent.providerMessageId }
      : { result: { sent: false, errorCode: sent.errorCode, retryable: sent.retryable } };
  }
}
