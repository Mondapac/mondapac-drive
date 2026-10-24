import {
  err,
  ok,
  type CallContext,
  type Clock,
  type IdGenerator,
  type Result,
  type Temporal,
} from '@mondapac-drive/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { EventDelivery } from '../../../../platform/events/event-delivery';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import {
  smsKindFor,
  webhookBody,
  type DeliveryChange,
  type WebhookEventType,
} from '../../domain/delivery-change';
import { newOutboundMessage } from '../../domain/outbound-message';
import { wants } from '../../domain/webhook-subscription';
import { ACCESS_DENIED, isSystem } from '../callers';
import type { NotificationsFailure } from '../failure';
import type {
  DeliveryContacts,
  OutboundRepository,
  WebhookCall,
  WebhookSubscriptionRepository,
} from '../ports';

/** The longest order reference an SMS row keeps (its column); a message shows at most 32. */
const MAX_STORED_REFERENCE = 128;

/** One consumed delivery event: its envelope's id and time, and the payload's ids and codes. */
export interface DeliveryEventInput {
  readonly delivery: EventDelivery;
  readonly eventId: string;
  readonly type: WebhookEventType;
  readonly occurredAt: Temporal.Instant;
  readonly deliveryId: string;
  readonly status: string;
  readonly previousStatus?: string;
  readonly reason?: string;
}

/** What one change queued: webhook calls written, and whether a recipient SMS was. */
export type QueuedNotifications =
  | { readonly handled: true; readonly webhookCalls: number; readonly sms: boolean }
  | { readonly handled: false };

export interface RecordDeliveryChangeDependencies {
  readonly contacts: DeliveryContacts;
  readonly subscriptions: WebhookSubscriptionRepository;
  readonly outbound: OutboundRepository;
  readonly unitOfWork: UnitOfWork;
  readonly ids: IdGenerator;
  readonly clock: Clock;
}

/**
 * Queues what one delivery change sends: a webhook call to each of the merchant's active
 * subscriptions that wants its type, and the recipient SMS of its kind. Rule `system`, from the
 * `notifications.delivery-*` subscriptions. The merchant and its order reference are read from
 * the delivery module first (the events carry ids and codes only), outside any unit; an unknown
 * delivery is refused, so the event is retried. Then one `runOnce` unit writes the inbox row and
 * the queue, so a repeated event queues nothing; the unique keys of calls and SMS hold as well.
 * Nothing is sent here: the dispatch jobs send and retry.
 */
export class RecordDeliveryChange extends UseCase<
  DeliveryEventInput,
  QueuedNotifications,
  NotificationsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'notifications.record-delivery-change',
    rule: { kind: 'system' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: RecordDeliveryChangeDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: DeliveryEventInput,
  ): Promise<Result<QueuedNotifications, NotificationsFailure>> {
    if (!isSystem(context)) return err(ACCESS_DENIED);
    const { market } = context;
    const { contacts, subscriptions, outbound, unitOfWork, ids, clock } = this.deps;
    const contact = await contacts.referenceOf(context, input.deliveryId);
    if (contact === undefined) {
      return err({ code: 'notifications.delivery-unknown', message: 'No such delivery' });
    }
    const change: DeliveryChange = {
      eventId: input.eventId,
      type: input.type,
      occurredAt: input.occurredAt,
      deliveryId: input.deliveryId,
      merchantId: contact.merchantId,
      externalReference: contact.externalReference,
      status: input.status,
      ...(input.previousStatus === undefined ? {} : { previousStatus: input.previousStatus }),
      ...(input.reason === undefined ? {} : { reason: input.reason }),
    };
    const body = JSON.stringify(webhookBody(market.marketId, change));
    const kind = smsKindFor(change);
    const done = await unitOfWork.runOnce(market, input.delivery, async () => {
      const now = clock.now();
      const targets = (await subscriptions.activeOf(market, change.merchantId)).filter(
        (subscription) => wants(subscription, change.type),
      );
      const calls: WebhookCall[] = targets.map((subscription) => ({
        ...newOutboundMessage(now),
        id: ids.next<'WebhookCall'>(),
        subscriptionId: subscription.id,
        eventId: change.eventId,
        eventType: change.type,
        body,
        lastStatusCode: null,
        createdAt: now,
      }));
      const webhookCalls = calls.length === 0 ? 0 : await outbound.insertCalls(market, calls);
      const sms =
        kind !== undefined &&
        (await outbound.insertSms(market, {
          ...newOutboundMessage(now),
          id: ids.next<'SmsMessage'>(),
          deliveryId: change.deliveryId,
          kind,
          eventId: change.eventId,
          reference: change.externalReference.slice(0, MAX_STORED_REFERENCE),
          providerMessageId: null,
          createdAt: now,
        })) === 1;
      return ok({ webhookCalls, sms });
    });
    if (!done.ok) return done;
    return ok(done.value.handled ? { handled: true, ...done.value.value } : { handled: false });
  }
}
