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
  EVENT_ID_HEADER,
  EVENT_TYPE_HEADER,
  SIGNATURE_HEADER,
  signatureHeader,
  signedContent,
  TIMESTAMP_HEADER,
  timestampOf,
} from '../../domain/webhook-signature';
import type { WebhookSubscription } from '../../domain/webhook-subscription';
import {
  NOTIFICATION_SETTINGS,
  OUTBOUND_REPOSITORY,
  WEBHOOK_SIGNER,
  WEBHOOK_SUBSCRIPTIONS,
  WEBHOOK_TRANSPORT,
  type NotificationSettingsProvider,
  type OutboundRepository,
  type WebhookCall,
  type WebhookSigner,
  type WebhookSubscriptionRepository,
  type WebhookTransport,
} from '../ports';

/** Calls one pass claims; their sends run side by side, each bounded by the transport timeout. */
export const DISPATCH_BATCH = 20;

/** An attempt that threw: retried like a network failure, never left unrecorded. */
export const INTERNAL_FAILURE: AttemptOutcome = {
  sent: false,
  errorCode: 'notifications.internal',
  retryable: true,
};

/** What one pass did. */
export interface DispatchSummary {
  readonly claimed: number;
  readonly sent: number;
  readonly dead: number;
}

interface Claimed {
  readonly call: WebhookCall;
  readonly subscription: WebhookSubscription | undefined;
}

/**
 * Sends the due webhook calls of one Market (the `notifications.webhook-dispatch` job): claims
 * a batch in one unit, signs and posts each outside any unit, then records each outcome in its
 * own unit. A failed call is retried with the Market's back-off and dead-lettered after its
 * attempts; a call whose subscription was disabled dies at once.
 */
@Injectable()
export class DispatchWebhooks {
  constructor(
    @Inject(OUTBOUND_REPOSITORY) private readonly outbound: OutboundRepository,
    @Inject(WEBHOOK_SUBSCRIPTIONS) private readonly subscriptions: WebhookSubscriptionRepository,
    @Inject(WEBHOOK_SIGNER) private readonly signer: WebhookSigner,
    @Inject(WEBHOOK_TRANSPORT) private readonly transport: WebhookTransport,
    @Inject(NOTIFICATION_SETTINGS) private readonly settings: NotificationSettingsProvider,
    @Inject(UNIT_OF_WORK) private readonly unitOfWork: UnitOfWork,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async run(market: MarketContext): Promise<DispatchSummary> {
    const policy = this.settings.get(market.marketId).webhookRetry;
    const claimed = await this.claimDue(market, policy);
    // One attempt that throws must not leave the others' outcomes unrecorded: they would be
    // sent again when their lease ends.
    const outcomes = await Promise.all(
      claimed.map(async ({ call, subscription }) => ({
        call,
        outcome: await this.attempt(call, subscription).catch(() => ({
          result: INTERNAL_FAILURE,
          statusCode: null,
        })),
      })),
    );
    let sent = 0;
    let dead = 0;
    for (const { call, outcome } of outcomes) {
      const next = {
        ...call,
        ...recordAttempt(call, outcome.result, this.clock.now(), policy),
        lastStatusCode: outcome.statusCode,
      };
      try {
        await this.unitOfWork.run(market, async () =>
          ok(await this.outbound.saveCall(market, next, call.attempts)),
        );
      } catch {
        // Unrecorded, the call comes due after its lease and counts this attempt; at its last
        // attempt it is dead-lettered instead of being claimed again.
        continue;
      }
      if (next.status === 'sent') sent += 1;
      if (next.status === 'dead') dead += 1;
    }
    return { claimed: claimed.length, sent, dead };
  }

  private async claimDue(market: MarketContext, policy: RetryPolicy): Promise<Claimed[]> {
    const result = await this.unitOfWork.run(market, async () => {
      const now = this.clock.now();
      const taken: Claimed[] = [];
      for (const due of await this.outbound.dueCalls(market, now, DISPATCH_BATCH)) {
        if (isExhausted(due, policy)) {
          await this.outbound.saveCall(market, { ...due, ...exhaust(due, now) }, due.attempts);
          continue;
        }
        const call = { ...due, ...claim(due, now) };
        if (!(await this.outbound.saveCall(market, call, due.attempts))) continue;
        taken.push({
          call,
          subscription: await this.subscriptions.findById(market, call.subscriptionId),
        });
      }
      return ok(taken);
    });
    return result.ok ? result.value : [];
  }

  private async attempt(
    call: WebhookCall,
    subscription: WebhookSubscription | undefined,
  ): Promise<{ result: AttemptOutcome; statusCode: number | null }> {
    if (subscription === undefined || subscription.status !== 'active') {
      return {
        result: { sent: false, errorCode: 'webhook-subscription.disabled', retryable: false },
        statusCode: null,
      };
    }
    const timestamp = timestampOf(this.clock.now());
    const digest = this.signer.sign(
      subscription.id,
      subscription.secretVersion,
      signedContent(timestamp, call.body),
    );
    const response = await this.transport.post(
      subscription.url,
      {
        'Content-Type': 'application/json',
        [TIMESTAMP_HEADER]: String(timestamp),
        [SIGNATURE_HEADER]: signatureHeader([digest]),
        [EVENT_ID_HEADER]: call.eventId,
        [EVENT_TYPE_HEADER]: call.eventType,
      },
      call.body,
    );
    return response.ok
      ? { result: { sent: true }, statusCode: response.statusCode }
      : {
          result: { sent: false, errorCode: response.errorCode, retryable: response.retryable },
          statusCode: response.statusCode,
        };
  }
}
