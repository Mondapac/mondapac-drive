import type { Clock, DomainEvent } from '@mondapac-drive/shared-kernel';
import type { EventBus, RelayTransaction } from '../../events/event-bus';
import type { SubscriptionRegistry } from '../../events/event-subscriptions';

/** The relay's transaction as this adapter uses it: the base client's raw statement. */
interface RawTransaction {
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
}

const FAN_OUT = `
INSERT INTO "platform"."event_delivery" (
  "event_id", "subscriber", "market_id", "tenant_id", "status", "attempts", "next_attempt_at",
  "type", "occurred_at", "aggregate_type", "aggregate_id", "aggregate_version",
  "correlation_id", "causation_id", "payload", "created_at")
VALUES ($1::uuid, $2, $3, $4, 'pending', 0, $5::timestamptz, $6, $7::timestamptz, $8, $9::uuid,
        $10, $11, $12::uuid, $13::jsonb, $5::timestamptz)
ON CONFLICT ("event_id", "subscriber") DO NOTHING`;

/**
 * The MVP adapter of ADR-0006 decision 4 (platform persistence design, "P", 6.3 to 6.5). It fans
 * each event out to `platform.event_delivery`, one `pending` row per subscription of its type,
 * due now, with a copy of the envelope, through the relay's transaction: the delivery rows and
 * the mark of the outbox rows commit or roll back together. A repeated `(event_id, subscriber)`
 * is ignored. An event with no subscription writes nothing, and an event published before a
 * subscription existed is not delivered to it later (PA1).
 */
export class InProcessEventBus implements EventBus {
  constructor(
    private readonly subscriptions: SubscriptionRegistry,
    private readonly clock: Clock,
  ) {}

  async publish(events: readonly DomainEvent[], transaction: RelayTransaction): Promise<void> {
    const raw = transaction as unknown as RawTransaction;
    const now = new Date(this.clock.now().epochMilliseconds);
    for (const event of events) {
      for (const subscriber of this.subscriptions.subscribersOf(event.type)) {
        await raw.$executeRawUnsafe(
          FAN_OUT,
          event.eventId,
          subscriber,
          event.market.marketId,
          event.market.tenantId,
          now,
          event.type,
          new Date(event.occurredAt.epochMilliseconds),
          event.aggregateType,
          event.aggregateId,
          event.aggregateVersion,
          event.correlationId,
          event.causationId,
          JSON.stringify(event.payload),
        );
      }
    }
  }
}
