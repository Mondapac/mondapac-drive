import { Inject, Injectable } from '@nestjs/common';
import { err, ok, type MarketContext, type Result } from '@mondapac-drive/shared-kernel';
import { UNIT_OF_WORK, type UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import {
  disableSubscription,
  rotateSecret,
  type WebhookSubscription,
} from '../../domain/webhook-subscription';
import { notFound, refusingBrokenRules, type NotificationsFailure } from '../failure';
import {
  WEBHOOK_SIGNER,
  WEBHOOK_SUBSCRIPTIONS,
  type WebhookSigner,
  type WebhookSubscriptionRepository,
} from '../ports';
import type { SubscriptionWithSecret } from './subscribe-to-webhooks.use-case';

/** Applies one step to a merchant's own subscription; another merchant's answers as missing. */
async function changeOwnSubscription(
  subscriptions: WebhookSubscriptionRepository,
  unitOfWork: UnitOfWork,
  market: MarketContext,
  merchantId: string,
  subscriptionId: string,
  step: (subscription: WebhookSubscription) => WebhookSubscription,
): Promise<Result<WebhookSubscription, NotificationsFailure>> {
  return unitOfWork.run(market, () =>
    refusingBrokenRules(async () => {
      const found = await subscriptions.findById(market, subscriptionId);
      if (found === undefined || found.merchantId !== merchantId) {
        return err(notFound('webhook-subscription'));
      }
      const next = step(found);
      if (next !== found) await subscriptions.update(market, next);
      return ok(next);
    }),
  );
}

/** A merchant rotates a subscription's secret: the old one stops signing at once. */
@Injectable()
export class RotateWebhookSecret {
  constructor(
    @Inject(WEBHOOK_SUBSCRIPTIONS) private readonly subscriptions: WebhookSubscriptionRepository,
    @Inject(WEBHOOK_SIGNER) private readonly signer: WebhookSigner,
    @Inject(UNIT_OF_WORK) private readonly unitOfWork: UnitOfWork,
  ) {}

  async run(
    market: MarketContext,
    merchantId: string,
    subscriptionId: string,
  ): Promise<Result<SubscriptionWithSecret, NotificationsFailure>> {
    const rotated = await changeOwnSubscription(
      this.subscriptions,
      this.unitOfWork,
      market,
      merchantId,
      subscriptionId,
      rotateSecret,
    );
    if (!rotated.ok) return rotated;
    const subscription = rotated.value;
    return ok({
      subscription,
      secret: this.signer.secretFor(subscription.id, subscription.secretVersion),
    });
  }
}

/** A merchant disables a subscription: no new calls; queued ones die when they come due. */
@Injectable()
export class DisableWebhookSubscription {
  constructor(
    @Inject(WEBHOOK_SUBSCRIPTIONS) private readonly subscriptions: WebhookSubscriptionRepository,
    @Inject(UNIT_OF_WORK) private readonly unitOfWork: UnitOfWork,
  ) {}

  run(
    market: MarketContext,
    merchantId: string,
    subscriptionId: string,
  ): Promise<Result<WebhookSubscription, NotificationsFailure>> {
    return changeOwnSubscription(
      this.subscriptions,
      this.unitOfWork,
      market,
      merchantId,
      subscriptionId,
      disableSubscription,
    );
  }
}
