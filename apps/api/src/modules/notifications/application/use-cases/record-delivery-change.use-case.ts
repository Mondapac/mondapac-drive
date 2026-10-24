import { Inject, Injectable } from '@nestjs/common';
import {
  ok,
  type Clock,
  type IdGenerator,
  type MarketContext,
  type Result,
} from '@mondapac-drive/shared-kernel';
import { CLOCK } from '../../../../platform/clock/clock.module';
import { ID_GENERATOR } from '../../../../platform/ids/ids.module';
import { UNIT_OF_WORK, type UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { smsKindFor, webhookBody, type DeliveryChange } from '../../domain/delivery-change';
import { newOutboundMessage } from '../../domain/outbound-message';
import { wants } from '../../domain/webhook-subscription';
import type { NotificationsFailure } from '../failure';
import {
  OUTBOUND_REPOSITORY,
  WEBHOOK_SUBSCRIPTIONS,
  type OutboundRepository,
  type WebhookCall,
  type WebhookSubscriptionRepository,
} from '../ports';

/** What one change queued: webhook calls written, and whether a recipient SMS was. */
export interface QueuedNotifications {
  readonly webhookCalls: number;
  readonly sms: boolean;
}

/**
 * Queues what one delivery change sends: a webhook call to each of the merchant's active
 * subscriptions that wants its type, and the recipient SMS of its kind. Nothing is sent here;
 * the dispatch jobs send and retry. A repeated change (the same event id) queues nothing new,
 * so the delivery outbox's at-least-once delivery sends each call and SMS once.
 */
@Injectable()
export class RecordDeliveryChange {
  constructor(
    @Inject(WEBHOOK_SUBSCRIPTIONS) private readonly subscriptions: WebhookSubscriptionRepository,
    @Inject(OUTBOUND_REPOSITORY) private readonly outbound: OutboundRepository,
    @Inject(UNIT_OF_WORK) private readonly unitOfWork: UnitOfWork,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  run(
    market: MarketContext,
    change: DeliveryChange,
  ): Promise<Result<QueuedNotifications, NotificationsFailure>> {
    const body = JSON.stringify(webhookBody(market.marketId, change));
    const kind = smsKindFor(change);
    return this.unitOfWork.run(market, async () => {
      const now = this.clock.now();
      const targets = (await this.subscriptions.activeOf(market, change.merchantId)).filter(
        (subscription) => wants(subscription, change.type),
      );
      const calls: WebhookCall[] = targets.map((subscription) => ({
        ...newOutboundMessage(now),
        id: this.ids.next<'WebhookCall'>(),
        subscriptionId: subscription.id,
        eventId: change.eventId,
        eventType: change.type,
        body,
        lastStatusCode: null,
        createdAt: now,
      }));
      const webhookCalls = calls.length === 0 ? 0 : await this.outbound.insertCalls(market, calls);
      const sms =
        kind !== undefined &&
        (await this.outbound.insertSms(market, {
          ...newOutboundMessage(now),
          id: this.ids.next<'SmsMessage'>(),
          deliveryId: change.deliveryId,
          kind,
          eventId: change.eventId,
          reference: change.externalReference,
          providerMessageId: null,
          createdAt: now,
        })) === 1;
      return ok({ webhookCalls, sms });
    });
  }
}
