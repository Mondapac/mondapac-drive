import { Temporal, type MarketContext } from '@mondapac-drive/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import { StaleAggregateError } from '../../../platform/unit-of-work/errors';
import type {
  OutboundRepository,
  SmsMessage,
  WebhookCall,
  WebhookSubscriptionRepository,
} from '../application/ports';
import type { SmsKind, WebhookEventType } from '../domain/delivery-change';
import type { MessageStatus, OutboundMessage } from '../domain/outbound-message';
import type { SubscriptionStatus, WebhookSubscription } from '../domain/webhook-subscription';
import type { WebhookUrl } from '../domain/webhook-url';

const toDate = (instant: Temporal.Instant): Date => new Date(instant.epochMilliseconds);
const toInstant = (date: Date): Temporal.Instant =>
  Temporal.Instant.fromEpochMilliseconds(date.getTime());
const maybeDate = (instant: Temporal.Instant | null): Date | null =>
  instant === null ? null : toDate(instant);
const maybeInstant = (date: Date | null): Temporal.Instant | null =>
  date === null ? null : toInstant(date);

const scope = (market: MarketContext) => ({
  marketId: market.marketId,
  tenantId: market.tenantId,
});

interface SubscriptionRow {
  readonly id: string;
  readonly marketId: string;
  readonly merchantId: string;
  readonly url: string;
  readonly eventTypes: string[];
  readonly secretVersion: number;
  readonly status: string;
  readonly createdAt: Date;
  readonly version: number;
}

function readSubscription(row: SubscriptionRow, market: MarketContext): WebhookSubscription {
  return {
    id: row.id,
    marketId: market.marketId,
    merchantId: row.merchantId,
    url: row.url as WebhookUrl,
    eventTypes: row.eventTypes as WebhookEventType[],
    secretVersion: row.secretVersion,
    status: row.status as SubscriptionStatus,
    createdAt: toInstant(row.createdAt),
    version: row.version,
  };
}

/** Webhook subscriptions in `notifications.webhook_subscriptions`. */
export class PrismaWebhookSubscriptionRepository implements WebhookSubscriptionRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findById(market: MarketContext, id: string) {
    const row = await this.prisma
      .tx(market)
      .notificationsWebhookSubscription.findFirst({ where: { ...scope(market), id } });
    return row === null ? undefined : readSubscription(row, market);
  }

  async activeOf(market: MarketContext, merchantId: string) {
    const rows = await this.prisma.tx(market).notificationsWebhookSubscription.findMany({
      where: { ...scope(market), merchantId, status: 'active' },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    return rows.map((row) => readSubscription(row, market));
  }

  async insert(market: MarketContext, subscription: WebhookSubscription): Promise<void> {
    await this.prisma.tx(market).notificationsWebhookSubscription.create({
      data: {
        ...scope(market),
        id: subscription.id,
        merchantId: subscription.merchantId,
        url: subscription.url,
        eventTypes: [...subscription.eventTypes],
        secretVersion: subscription.secretVersion,
        status: subscription.status,
        createdAt: toDate(subscription.createdAt),
        version: subscription.version,
      },
    });
  }

  async update(market: MarketContext, subscription: WebhookSubscription): Promise<void> {
    const updated = await this.prisma.tx(market).notificationsWebhookSubscription.updateMany({
      where: { ...scope(market), id: subscription.id, version: subscription.version - 1 },
      data: {
        secretVersion: subscription.secretVersion,
        status: subscription.status,
        version: subscription.version,
      },
    });
    if (updated.count !== 1) throw new StaleAggregateError('webhook-subscription', subscription.id);
  }
}

interface MessageRow {
  readonly status: string;
  readonly attempts: number;
  readonly nextAttemptAt: Date | null;
  readonly lastErrorCode: string | null;
  readonly sentAt: Date | null;
  readonly deadAt: Date | null;
}

function readMessage(row: MessageRow): OutboundMessage {
  return {
    status: row.status as MessageStatus,
    attempts: row.attempts,
    nextAttemptAt: maybeInstant(row.nextAttemptAt),
    lastErrorCode: row.lastErrorCode,
    sentAt: maybeInstant(row.sentAt),
    deadAt: maybeInstant(row.deadAt),
  };
}

function storedMessage(message: OutboundMessage) {
  return {
    status: message.status,
    attempts: message.attempts,
    nextAttemptAt: maybeDate(message.nextAttemptAt),
    lastErrorCode: message.lastErrorCode,
    sentAt: maybeDate(message.sentAt),
    deadAt: maybeDate(message.deadAt),
  };
}

interface CallRow extends MessageRow {
  readonly id: string;
  readonly subscriptionId: string;
  readonly eventId: string;
  readonly eventType: string;
  readonly body: string;
  readonly lastStatusCode: number | null;
  readonly createdAt: Date;
}

function readCall(row: CallRow): WebhookCall {
  return {
    ...readMessage(row),
    id: row.id,
    subscriptionId: row.subscriptionId,
    eventId: row.eventId,
    eventType: row.eventType as WebhookEventType,
    body: row.body,
    lastStatusCode: row.lastStatusCode,
    createdAt: toInstant(row.createdAt),
  };
}

interface SmsRow extends MessageRow {
  readonly id: string;
  readonly deliveryId: string;
  readonly kind: string;
  readonly eventId: string;
  readonly reference: string;
  readonly providerMessageId: string | null;
  readonly createdAt: Date;
}

function readSms(row: SmsRow): SmsMessage {
  return {
    ...readMessage(row),
    id: row.id,
    deliveryId: row.deliveryId,
    kind: row.kind as SmsKind,
    eventId: row.eventId,
    reference: row.reference,
    providerMessageId: row.providerMessageId,
    createdAt: toInstant(row.createdAt),
  };
}

/** Queued webhook calls and SMS in `notifications.webhook_calls` and `notifications.sms_messages`. */
export class PrismaOutboundRepository implements OutboundRepository {
  constructor(private readonly prisma: PrismaService) {}

  async insertCalls(market: MarketContext, calls: readonly WebhookCall[]): Promise<number> {
    const created = await this.prisma.tx(market).notificationsWebhookCall.createMany({
      data: calls.map((call) => ({
        ...scope(market),
        ...storedMessage(call),
        id: call.id,
        subscriptionId: call.subscriptionId,
        eventId: call.eventId,
        eventType: call.eventType,
        body: call.body,
        lastStatusCode: call.lastStatusCode,
        createdAt: toDate(call.createdAt),
      })),
      skipDuplicates: true,
    });
    return created.count;
  }

  async insertSms(market: MarketContext, message: SmsMessage): Promise<number> {
    const created = await this.prisma.tx(market).notificationsSmsMessage.createMany({
      data: [
        {
          ...scope(market),
          ...storedMessage(message),
          id: message.id,
          deliveryId: message.deliveryId,
          kind: message.kind,
          eventId: message.eventId,
          reference: message.reference,
          providerMessageId: message.providerMessageId,
          createdAt: toDate(message.createdAt),
        },
      ],
      skipDuplicates: true,
    });
    return created.count;
  }

  async dueCalls(market: MarketContext, now: Temporal.Instant, limit: number) {
    const rows = await this.prisma.tx(market).notificationsWebhookCall.findMany({
      where: { ...scope(market), status: 'pending', nextAttemptAt: { lte: toDate(now) } },
      orderBy: [{ nextAttemptAt: 'asc' }, { id: 'asc' }],
      take: limit,
    });
    return rows.map(readCall);
  }

  async dueSms(market: MarketContext, now: Temporal.Instant, limit: number) {
    const rows = await this.prisma.tx(market).notificationsSmsMessage.findMany({
      where: { ...scope(market), status: 'pending', nextAttemptAt: { lte: toDate(now) } },
      orderBy: [{ nextAttemptAt: 'asc' }, { id: 'asc' }],
      take: limit,
    });
    return rows.map(readSms);
  }

  async findCall(market: MarketContext, id: string) {
    const row = await this.prisma
      .tx(market)
      .notificationsWebhookCall.findFirst({ where: { ...scope(market), id } });
    return row === null ? undefined : readCall(row);
  }

  async saveCall(market: MarketContext, call: WebhookCall, expectedAttempts: number) {
    const updated = await this.prisma.tx(market).notificationsWebhookCall.updateMany({
      where: { ...scope(market), id: call.id, attempts: expectedAttempts },
      data: { ...storedMessage(call), lastStatusCode: call.lastStatusCode },
    });
    return updated.count === 1;
  }

  async saveSms(market: MarketContext, message: SmsMessage, expectedAttempts: number) {
    const updated = await this.prisma.tx(market).notificationsSmsMessage.updateMany({
      where: { ...scope(market), id: message.id, attempts: expectedAttempts },
      data: { ...storedMessage(message), providerMessageId: message.providerMessageId },
    });
    return updated.count === 1;
  }
}
