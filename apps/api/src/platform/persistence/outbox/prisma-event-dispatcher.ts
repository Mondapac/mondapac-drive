import { Logger } from '@nestjs/common';
import { parseCorrelationId, parseId, Temporal } from '@mondapac-drive/shared-kernel';
import type { Clock, JsonObject, MarketContext } from '@mondapac-drive/shared-kernel';
import { createCallContext, systemActor } from '@mondapac-drive/shared-kernel/contexts';
import { decodePayload } from '../../events/decode-payload';
import {
  BACK_OFF_BASE_SECONDS,
  BACK_OFF_MAX_SECONDS,
  DISPATCH_BATCH_SIZE,
  HANDLER_BUDGET_MS,
  MAX_DELIVERY_ATTEMPTS,
  type DispatchPass,
  type EventDispatcher,
} from '../../events/event-delivery';
import type {
  ConsumedEnvelope,
  SubscriberContext,
  SubscriptionRegistry,
} from '../../events/event-subscriptions';
import type { MarketRegistry } from '../../market-config/market-registry';
import type { MarketContextFactory } from '../../market-context/market-context.factory';
import { CONNECTION_WAIT_MS, DEFAULT_UNIT_TIMEOUT_MS } from '../../unit-of-work/unit-of-work';
import type { PrismaRoot } from '../prisma-root';
import { deliverySettled, issueDelivery } from './delivery-ledger';

/** A claimed row of `platform.event_delivery` (data design 3.8). */
interface DeliveryRecord {
  readonly event_id: string;
  readonly subscriber: string;
  readonly market_id: string;
  readonly tenant_id: string;
  readonly attempts: number;
  /** The end of this claim's lease: the database's own value, which the give-back matches. */
  readonly next_attempt_at: Date;
  readonly type: string;
  readonly occurred_at: Date;
  readonly aggregate_type: string;
  readonly aggregate_id: string;
  readonly aggregate_version: number;
  readonly correlation_id: string;
  readonly causation_id: string | null;
  readonly payload: JsonObject;
}

/**
 * P 6.4: the claim counts the attempt and moves `next_attempt_at` by the back-off of the new
 * count, `min(30 s × 2^(attempts − 1), 1 h)` (the old count is the exponent), so a handler that
 * crashes needs no bookkeeping. `FOR UPDATE SKIP LOCKED` gives concurrent dispatchers disjoint
 * rows. The tenant filter is the relay's, for the same reason (one minted context per Market).
 */
const CLAIM = `
UPDATE "platform"."event_delivery" d
   SET "attempts" = d."attempts" + 1,
       "next_attempt_at" = $2::timestamptz
         + make_interval(secs => LEAST(${BACK_OFF_BASE_SECONDS} * power(2, LEAST(d."attempts", 20)), ${BACK_OFF_MAX_SECONDS}))
 WHERE (d."event_id", d."subscriber") IN (
         SELECT "event_id", "subscriber" FROM "platform"."event_delivery"
          WHERE "market_id" = $1 AND "tenant_id" = $4 AND "status" = 'pending'
            AND "next_attempt_at" <= $2::timestamptz
          ORDER BY "next_attempt_at" LIMIT $3
            FOR UPDATE SKIP LOCKED)
RETURNING d."event_id", d."subscriber", d."market_id", d."tenant_id", d."attempts",
          d."next_attempt_at", d."type",
          d."occurred_at", d."aggregate_type", d."aggregate_id", d."aggregate_version",
          d."correlation_id", d."causation_id", d."payload"`;

const DEAD = `
UPDATE "platform"."event_delivery"
   SET "status" = 'dead', "dead_at" = $4::timestamptz, "error_code" = $5
 WHERE "market_id" = $1 AND "event_id" = $2::uuid AND "subscriber" = $3 AND "status" = 'pending'`;

/**
 * Gives back a claimed row whose handler did not start (Mojtaba F1): the claim's attempt is
 * undone and the row is due now, only while the row still holds this claim: its attempts and its
 * lease end both as this claim returned them. The lease end comes from the claim's `now`, so a
 * later claim (even one released again, which restores the count: C1) never matches.
 */
const RELEASE = `
UPDATE "platform"."event_delivery"
   SET "attempts" = "attempts" - 1, "next_attempt_at" = $4::timestamptz
 WHERE "market_id" = $1 AND "event_id" = $2::uuid AND "subscriber" = $3 AND "status" = 'pending'
   AND "attempts" = $5 AND "next_attempt_at" = $6::timestamptz`;

const FAILED = `
UPDATE "platform"."event_delivery" SET "error_code" = $4
 WHERE "market_id" = $1 AND "event_id" = $2::uuid AND "subscriber" = $3 AND "status" = 'pending'`;

/** Why a delivery failed: a code, never a message or a value (P 12.3). */
export type DeliveryFailure =
  | 'delivery.unknown-subscriber'
  | 'delivery.type-mismatch'
  | 'delivery.envelope-invalid'
  | 'delivery.payload-undecodable'
  | 'delivery.handler-failed'
  | 'delivery.not-consumed';

/** Failures no retry can mend: the row is dead-lettered at once (P 6.4). */
const PERMANENT: ReadonlySet<DeliveryFailure> = new Set([
  'delivery.unknown-subscriber',
  'delivery.type-mismatch',
  'delivery.envelope-invalid',
  'delivery.payload-undecodable',
]);

type Parsed<T> = { ok: true; value: T } | { ok: false };
const valueOf = <T>(parsed: Parsed<T>): T | null => (parsed.ok ? parsed.value : null);

/**
 * The dispatcher of platform persistence design, "P", 6.4, for the `worker` role. One pass, per
 * hosted Market: claim up to 20 due deliveries in a short transaction of its own, then run each
 * one's handler with the entry adapter of foundations 5.1: the Market's context from the
 * factory, that Market's system actor and the envelope's correlation id. The handler calls one
 * `system` use case, whose `runOnce` marks the delivery delivered; a handler that throws, or
 * returns without a committed `runOnce`, has failed, and the row comes due again after its
 * back-off. After 10 claims it is `dead`, with an error code and one error-level line marked
 * for alerting. An unknown subscriber, a type that is not the subscription's, or an envelope
 * or payload that does not decode is dead at once. Logs carry event id, type, subscriber,
 * Market and correlation id; never a payload or an error message.
 */
export class PrismaEventDispatcher implements EventDispatcher {
  private readonly logger = new Logger('EventDispatcher');

  constructor(
    private readonly root: PrismaRoot,
    private readonly markets: MarketRegistry,
    private readonly contexts: MarketContextFactory,
    private readonly subscriptions: SubscriptionRegistry,
    private readonly clock: Clock,
  ) {}

  async runOnce(): Promise<DispatchPass> {
    let claimed = 0;
    let fullBatch = false;
    for (const marketId of this.markets.hostedMarketIds()) {
      const context = this.contexts.forMarket(marketId);
      if (!context.ok) throw new Error(`The hosted Market ${marketId} has no context`);
      const rows = await this.claim(context.value);
      claimed += rows.length;
      if (rows.length === DISPATCH_BATCH_SIZE) fullBatch = true;
      for (const [index, row] of rows.entries()) {
        if (!this.leaseCovers(row)) {
          await this.release(rows.slice(index));
          break;
        }
        await this.deliver(row, context.value);
      }
    }
    return { claimed, fullBatch };
  }

  /**
   * Whether the row's lease still has room for a whole handler (Mojtaba F1, C2): handlers of a
   * batch run one after the other, so a late row of a slow batch would otherwise run while
   * another dispatcher claims it again. Measured against the lease end the claim stored, which
   * starts at the claim's own `now`, not at the end of the claim's transaction.
   */
  private leaseCovers(row: DeliveryRecord): boolean {
    return this.clock.now().epochMilliseconds + HANDLER_BUDGET_MS <= row.next_attempt_at.getTime();
  }

  /** Gives back the rest of a batch whose lease ran short, without spending an attempt. */
  private async release(rows: readonly DeliveryRecord[]): Promise<void> {
    const now = new Date(this.clock.now().epochMilliseconds);
    for (const row of rows) {
      await this.root.$executeRawUnsafe(
        RELEASE,
        row.market_id,
        row.event_id,
        row.subscriber,
        now,
        row.attempts,
        row.next_attempt_at,
      );
    }
    this.logger.warn({
      msg: 'event-delivery.lease-short',
      marketId: rows[0]!.market_id,
      released: rows.length,
    });
  }

  private claim(market: MarketContext): Promise<DeliveryRecord[]> {
    return this.root.$transaction(
      (transaction) =>
        transaction.$queryRawUnsafe<DeliveryRecord[]>(
          CLAIM,
          market.marketId,
          new Date(this.clock.now().epochMilliseconds),
          DISPATCH_BATCH_SIZE,
          market.tenantId,
        ),
      { maxWait: CONNECTION_WAIT_MS, timeout: DEFAULT_UNIT_TIMEOUT_MS },
    );
  }

  private async deliver(row: DeliveryRecord, market: MarketContext): Promise<void> {
    const subscription = this.subscriptions.get(row.subscriber);
    if (subscription === undefined) return this.fail(row, 'delivery.unknown-subscriber');
    if (subscription.event.type !== row.type) return this.fail(row, 'delivery.type-mismatch');

    const eventId = valueOf(parseId<'event'>(row.event_id));
    const aggregateId = valueOf(parseId(row.aggregate_id));
    const correlationId = valueOf(parseCorrelationId(row.correlation_id));
    const causationId = row.causation_id === null ? null : valueOf(parseId(row.causation_id));
    const payload = decodePayload(subscription.event.fields, row.payload);
    if (
      row.market_id !== market.marketId ||
      row.tenant_id !== market.tenantId ||
      eventId === null ||
      aggregateId === null ||
      correlationId === null ||
      (row.causation_id !== null && causationId === null)
    ) {
      return this.fail(row, 'delivery.envelope-invalid');
    }
    if (!payload.ok) return this.fail(row, 'delivery.payload-undecodable');

    // The payload was just decoded against this subscription's own definition.
    const event: ConsumedEnvelope = Object.freeze({
      eventId,
      type: row.type,
      occurredAt: Temporal.Instant.fromEpochMilliseconds(row.occurred_at.getTime()),
      market,
      aggregateType: row.aggregate_type,
      aggregateId,
      aggregateVersion: row.aggregate_version,
      correlationId,
      causationId,
      payload: payload.value,
    });
    // The entry adapter of foundations 5.1: the Market's system actor, the envelope's correlation.
    const context: SubscriberContext = createCallContext(
      market,
      systemActor(market),
      correlationId,
    );
    const delivery = issueDelivery(
      { eventId, subscriber: row.subscriber, attempt: row.attempts },
      market,
      () => this.clock.now(),
    );
    try {
      await subscription.handle(event, delivery, context);
    } catch (error) {
      // The `err` serializer logs the name, code, SQLSTATE and frames only (P 12.3).
      this.logger.warn({ msg: 'event-delivery.handler-failed', ...this.fields(row), err: error });
      return this.fail(row, 'delivery.handler-failed');
    }
    if (!deliverySettled(delivery)) return this.fail(row, 'delivery.not-consumed');
    this.logger.debug({ msg: 'event-delivery.delivered', ...this.fields(row) });
  }

  /** A failed delivery: dead at once when permanent or at the last attempt; else retried. */
  private async fail(row: DeliveryRecord, code: DeliveryFailure): Promise<void> {
    const now = new Date(this.clock.now().epochMilliseconds);
    if (PERMANENT.has(code) || row.attempts >= MAX_DELIVERY_ATTEMPTS) {
      await this.root.$executeRawUnsafe(
        DEAD,
        row.market_id,
        row.event_id,
        row.subscriber,
        now,
        code,
      );
      // ADR-0006 decision 4: one error-level line, marked for alerting.
      this.logger.error({
        msg: 'event-delivery.dead',
        alert: true,
        errorCode: code,
        ...this.fields(row),
      });
      return;
    }
    await this.root.$executeRawUnsafe(FAILED, row.market_id, row.event_id, row.subscriber, code);
    this.logger.warn({ msg: 'event-delivery.failed', errorCode: code, ...this.fields(row) });
  }

  private fields(row: DeliveryRecord) {
    return {
      eventId: row.event_id,
      type: row.type,
      subscriber: row.subscriber,
      marketId: row.market_id,
      correlationId: row.correlation_id,
      attempt: row.attempts,
    };
  }
}
