import { Inject, Injectable } from '@nestjs/common';
import {
  err,
  ok,
  type Clock,
  type IdGenerator,
  type MarketContext,
  type Result,
} from '@mondapac-drive/shared-kernel';
import { CLOCK } from '../../../../platform/clock/clock.module';
import { ID_GENERATOR } from '../../../../platform/ids/ids.module';
import { UNIT_OF_WORK, type UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { isWebhookEventType, type WebhookEventType } from '../../domain/delivery-change';
import {
  createSubscription,
  MAX_SUBSCRIPTIONS_PER_MERCHANT,
  type WebhookSubscription,
} from '../../domain/webhook-subscription';
import { parseWebhookUrl } from '../../domain/webhook-url';
import { refusingBrokenRules, type NotificationsFailure } from '../failure';
import {
  WEBHOOK_SIGNER,
  WEBHOOK_SUBSCRIPTIONS,
  type WebhookSigner,
  type WebhookSubscriptionRepository,
} from '../ports';

export interface SubscribeInput {
  readonly merchantId: string;
  readonly url: string;
  readonly eventTypes: readonly string[];
}

/** A subscription and its signing secret: the only answer that ever shows the secret. */
export interface SubscriptionWithSecret {
  readonly subscription: WebhookSubscription;
  readonly secret: string;
}

const MERCHANT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

/**
 * A merchant subscribes an HTTPS endpoint to delivery events and receives its signing secret,
 * once. The merchant comes from the caller's authenticated context once identity (WP2) gates
 * this use case; until then no route reaches it.
 */
@Injectable()
export class SubscribeToWebhooks {
  constructor(
    @Inject(WEBHOOK_SUBSCRIPTIONS) private readonly subscriptions: WebhookSubscriptionRepository,
    @Inject(WEBHOOK_SIGNER) private readonly signer: WebhookSigner,
    @Inject(UNIT_OF_WORK) private readonly unitOfWork: UnitOfWork,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async run(
    market: MarketContext,
    input: SubscribeInput,
  ): Promise<Result<SubscriptionWithSecret, NotificationsFailure>> {
    if (!MERCHANT_ID.test(input.merchantId)) {
      return err({ code: 'webhook-subscription.merchant-invalid', message: 'Invalid merchant id' });
    }
    const url = parseWebhookUrl(input.url);
    if (!url.ok) return err({ code: url.error, message: 'The webhook URL is not allowed' });
    const eventTypes: WebhookEventType[] = [];
    for (const type of input.eventTypes) {
      if (!isWebhookEventType(type)) {
        return err({
          code: 'webhook-subscription.unknown-event-type',
          message: 'Unknown event type',
        });
      }
      eventTypes.push(type);
    }
    const subscription = await this.unitOfWork.run(market, () =>
      refusingBrokenRules(async () => {
        const active = await this.subscriptions.activeOf(market, input.merchantId);
        if (active.length >= MAX_SUBSCRIPTIONS_PER_MERCHANT) {
          return err({
            code: 'webhook-subscription.limit',
            message: `At most ${MAX_SUBSCRIPTIONS_PER_MERCHANT} active subscriptions`,
          });
        }
        const created = createSubscription({
          id: this.ids.next<'WebhookSubscription'>(),
          marketId: market.marketId,
          merchantId: input.merchantId,
          url: url.value,
          eventTypes,
          createdAt: this.clock.now(),
        });
        await this.subscriptions.insert(market, created);
        return ok(created);
      }),
    );
    return subscription.ok
      ? ok({
          subscription: subscription.value,
          secret: this.signer.secretFor(subscription.value.id, subscription.value.secretVersion),
        })
      : subscription;
  }
}
