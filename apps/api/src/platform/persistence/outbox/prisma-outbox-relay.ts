import { Logger } from '@nestjs/common';
import { parseCorrelationId, parseId, Temporal } from '@mondapac-drive/shared-kernel';
import type { Clock, DomainEvent, JsonObject, MarketContext } from '@mondapac-drive/shared-kernel';
import type { MarketRegistry } from '../../market-config/market-registry';
import type { MarketContextFactory } from '../../market-context/market-context.factory';
import {
  RELAY_BATCH_SIZE,
  RELAY_LAG_LOG_MS,
  type EventBus,
  type OutboxRelay,
  type RelayPass,
  type RelayTransaction,
} from '../../events/event-bus';
import { CONNECTION_WAIT_MS, DEFAULT_UNIT_TIMEOUT_MS } from '../../unit-of-work/unit-of-work';
import type { ModelMap } from '../model-map';
import type { PrismaRoot } from '../prisma-root';

/** A schema or table name from the model map, safe to quote into SQL. */
const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

/** One module's outbox table, as the relay addresses it. */
export interface OutboxTable {
  readonly module: string;
  readonly schema: string;
  readonly table: string;
}

/** Every module outbox of the model map (P 6.1). */
export function outboxTablesOf(map: ModelMap): OutboxTable[] {
  const tables: OutboxTable[] = [];
  for (const [module, entry] of Object.entries(map.modules)) {
    if (entry.outboxModel === null) continue;
    const model = map.models[entry.outboxModel];
    const schema = model?.schema ?? null;
    if (
      model === undefined ||
      schema === null ||
      !IDENTIFIER.test(schema) ||
      !IDENTIFIER.test(model.table)
    ) {
      throw new Error(`The outbox of module "${module}" has no usable schema and table in the map`);
    }
    tables.push({ module, schema, table: model.table });
  }
  return tables.sort((a, b) => (a.module < b.module ? -1 : a.module > b.module ? 1 : 0));
}

/** The envelope columns as the claim returns them (data design 3.1). */
interface OutboxRecord {
  readonly event_id: string;
  readonly type: string;
  readonly occurred_at: Date;
  readonly market_id: string;
  readonly tenant_id: string;
  readonly aggregate_type: string;
  readonly aggregate_id: string;
  readonly aggregate_version: number;
  readonly correlation_id: string;
  readonly causation_id: string | null;
  readonly payload: JsonObject;
}

const ENVELOPE_COLUMNS =
  'event_id, type, occurred_at, market_id, tenant_id, aggregate_type, aggregate_id, ' +
  'aggregate_version, correlation_id, causation_id, payload';

/** A row the database accepted but the kernel does not: a broken invariant, never skipped. */
function checked<T>(result: { ok: true; value: T } | { ok: false }, column: string): T {
  if (!result.ok) throw new Error(`An outbox row has a malformed ${column}`);
  return result.value;
}

function eventOf(row: OutboxRecord, market: MarketContext): DomainEvent {
  if (row.market_id !== market.marketId || row.tenant_id !== market.tenantId) {
    throw new Error('An outbox row of another Market or tenant was claimed');
  }
  return Object.freeze({
    eventId: checked(parseId<'event'>(row.event_id), 'event_id'),
    type: row.type,
    occurredAt: Temporal.Instant.fromEpochMilliseconds(row.occurred_at.getTime()),
    market,
    aggregateType: row.aggregate_type,
    aggregateId: checked(parseId(row.aggregate_id), 'aggregate_id'),
    aggregateVersion: row.aggregate_version,
    correlationId: checked(parseCorrelationId(row.correlation_id), 'correlation_id'),
    causationId:
      row.causation_id === null ? null : checked(parseId(row.causation_id), 'causation_id'),
    payload: row.payload,
  });
}

/**
 * The relay of platform persistence design, "P", 6.1, for the `worker` role. One pass visits
 * every module outbox of the model map and, for each, every hosted Market, each in one short
 * transaction of its own on the base client: claim up to 50 unpublished rows of that Market
 * and tenant with `FOR UPDATE SKIP LOCKED`, hand them to the bus with the transaction, mark
 * them published at the `Clock` instant, commit. A failure rolls the batch back, so the rows
 * stay unpublished and the next pass of any worker takes them (P 6.2): at least once, no loss,
 * no order. Logs carry event id, type, Market and correlation id; never a payload.
 *
 * Deviation from the SQL of P 6.1, named: the claim also filters on `tenant_id`, the tenant of
 * the Market's context, because a `DomainEvent` carries one minted `MarketContext`; there is
 * one tenant (ADR-0001), so it selects the same rows.
 */
export class PrismaOutboxRelay implements OutboxRelay {
  private readonly logger = new Logger('OutboxRelay');
  private readonly tables: readonly OutboxTable[];

  constructor(
    private readonly root: PrismaRoot,
    map: ModelMap,
    private readonly markets: MarketRegistry,
    private readonly contexts: MarketContextFactory,
    private readonly bus: EventBus,
    private readonly clock: Clock,
  ) {
    this.tables = outboxTablesOf(map);
  }

  async runOnce(): Promise<RelayPass> {
    let published = 0;
    let fullBatch = false;
    for (const table of this.tables) {
      for (const marketId of this.markets.hostedMarketIds()) {
        const context = this.contexts.forMarket(marketId);
        if (!context.ok) throw new Error(`The hosted Market ${marketId} has no context`);
        const count = await this.relayBatch(table, context.value);
        published += count;
        if (count === RELAY_BATCH_SIZE) fullBatch = true;
      }
    }
    return { published, fullBatch };
  }

  async unhostedMarketsWithRows(): Promise<readonly string[]> {
    const hosted = this.markets.hostedMarketIds().map(String);
    const found = new Set<string>();
    for (const { schema, table } of this.tables) {
      const rows = await this.root.$queryRawUnsafe<{ market_id: string }[]>(
        `SELECT DISTINCT market_id FROM "${schema}"."${table}"
          WHERE published_at IS NULL AND market_id <> ALL($1::text[])`,
        hosted,
      );
      for (const row of rows) found.add(row.market_id);
    }
    return [...found].sort();
  }

  private async relayBatch(outbox: OutboxTable, market: MarketContext): Promise<number> {
    const { schema, table } = outbox;
    return this.root.$transaction(
      async (transaction) => {
        const rows = await transaction.$queryRawUnsafe<OutboxRecord[]>(
          `SELECT ${ENVELOPE_COLUMNS} FROM "${schema}"."${table}"
            WHERE market_id = $1 AND tenant_id = $2 AND published_at IS NULL
            ORDER BY event_id LIMIT $3
              FOR UPDATE SKIP LOCKED`,
          market.marketId,
          market.tenantId,
          RELAY_BATCH_SIZE,
        );
        if (rows.length === 0) return 0;

        const events = rows.map((row) => eventOf(row, market));
        const now = this.clock.now();
        this.logLag(outbox, market, events[0]!, now);
        await this.bus.publish(events, transaction as unknown as RelayTransaction);
        await transaction.$executeRawUnsafe(
          `UPDATE "${schema}"."${table}" SET published_at = $1
            WHERE market_id = $2 AND tenant_id = $3 AND event_id = ANY($4::uuid[])`,
          new Date(now.epochMilliseconds),
          market.marketId,
          market.tenantId,
          events.map((event) => event.eventId),
        );
        for (const event of events) {
          this.logger.debug({
            msg: 'outbox.event-published',
            eventId: event.eventId,
            type: event.type,
            marketId: market.marketId,
            correlationId: event.correlationId,
          });
        }
        return rows.length;
      },
      { maxWait: CONNECTION_WAIT_MS, timeout: DEFAULT_UNIT_TIMEOUT_MS },
    );
  }

  /** P 6.2 and PK3: the age of the oldest row of the batch, when above 5 s. */
  private logLag(
    outbox: OutboxTable,
    market: MarketContext,
    oldest: DomainEvent,
    now: Temporal.Instant,
  ): void {
    const ageMs = now.epochMilliseconds - oldest.occurredAt.epochMilliseconds;
    if (ageMs <= RELAY_LAG_LOG_MS) return;
    this.logger.warn({
      msg: 'outbox.lagging',
      module: outbox.module,
      marketId: market.marketId,
      eventId: oldest.eventId,
      ageMs,
    });
  }
}
