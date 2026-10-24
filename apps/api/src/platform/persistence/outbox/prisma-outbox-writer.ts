import {
  checkAggregateVersion,
  encodePayload,
  isMinted,
  parseCorrelationId,
  parseId,
  Temporal,
} from '@mondapac-drive/shared-kernel';
import type { CallContext, Id, IdGenerator, PendingEvent } from '@mondapac-drive/shared-kernel';
import type { EventCatalogue } from '../../events/event-catalogue';
import {
  OutboxWriteRefusedError,
  type OutboxWriter,
  type OutboxWriterFactory,
  type PermissionKeyLookup,
} from '../../events/outbox-writer';
import { NoUnitOfWorkError } from '../../unit-of-work/errors';
import type { ModelMap } from '../model-map';
import type { PrismaService } from '../prisma.service';
import { unitStorage } from '../unit-store';

type OutboxDelegate = { createMany(args: { data: readonly OutboxRow[] }): Promise<unknown> };

/** One row of `<module>.outbox` (data design 3.1), as the guarded delegate takes it. */
interface OutboxRow {
  readonly eventId: string;
  readonly type: string;
  readonly occurredAt: Date;
  readonly marketId: string;
  readonly tenantId: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly aggregateVersion: number;
  readonly correlationId: string;
  readonly causationId: string | null;
  readonly payload: object;
  readonly publishedAt: null;
}

/**
 * The outbox writer of platform persistence design, "P", 5.2, bound to one module. It writes
 * through the module's outbox model of the open unit (`PrismaService.tx`), so the market guard
 * checks the Market and tenant of every row like any other (P 4), and the unit's commit or
 * rollback decides the rows with the state change.
 */
class PrismaOutboxWriter implements OutboxWriter {
  constructor(
    private readonly module: string,
    private readonly clientProperty: string,
    private readonly prisma: PrismaService,
    private readonly catalogue: EventCatalogue,
    private readonly ids: IdGenerator,
    private readonly permissionKeys: PermissionKeyLookup,
  ) {}

  async append(
    context: CallContext,
    events: readonly PendingEvent[],
    causedBy?: Id,
  ): Promise<void> {
    // Foundations 3.7: a context copied, spread or rebuilt from JSON is refused.
    if (!isMinted(context)) throw new OutboxWriteRefusedError('context-not-minted');
    const unit = unitStorage.getStore();
    if (unit === undefined || unit.closed) throw new NoUnitOfWorkError();
    if (unit.readOnly) throw new OutboxWriteRefusedError('read-only-unit');
    // Throws MarketMismatchError for an unminted context or another Market or tenant (P 3.3).
    const view = this.prisma.tx(context.market);
    const correlation = parseCorrelationId(context.correlationId);
    if (!correlation.ok) throw new OutboxWriteRefusedError('correlation-id-invalid');
    if (causedBy !== undefined && !parseId(causedBy).ok) {
      throw new OutboxWriteRefusedError('causation-id-invalid');
    }
    if (events.length === 0) return;

    const rows = events.map((event) => this.rowOf(event, context, causedBy ?? null));
    const delegate = (view as unknown as Record<string, OutboxDelegate>)[this.clientProperty]!;
    await delegate.createMany({ data: rows });
  }

  private rowOf(event: PendingEvent, context: CallContext, causationId: string | null): OutboxRow {
    const definition = this.catalogue.get(event.type);
    if (definition === undefined) {
      throw new OutboxWriteRefusedError(
        typeof event.type === 'string' && event.type.startsWith(`${this.module}.`)
          ? 'type-not-in-catalogue'
          : 'type-of-another-module',
      );
    }
    if (definition.module !== this.module) {
      throw new OutboxWriteRefusedError('type-of-another-module');
    }
    if (event.aggregateType !== definition.aggregateType) {
      throw new OutboxWriteRefusedError('aggregate-type-mismatch');
    }
    if (typeof event.aggregateId !== 'string' || !parseId(event.aggregateId).ok) {
      throw new OutboxWriteRefusedError('aggregate-id-invalid');
    }
    if (!checkAggregateVersion(event.aggregateVersion)) {
      throw new OutboxWriteRefusedError('version-out-of-range');
    }
    if (!(event.occurredAt instanceof Temporal.Instant)) {
      throw new OutboxWriteRefusedError('occurred-at-invalid');
    }
    const payload = encodePayload(definition.fields, event.payload, this.permissionKeys);
    if (!payload.ok) throw new OutboxWriteRefusedError('payload-invalid', payload.error.field);

    return {
      eventId: this.ids.next<'event'>(),
      type: definition.type,
      occurredAt: new Date(event.occurredAt.epochMilliseconds),
      marketId: context.market.marketId,
      tenantId: context.market.tenantId,
      aggregateType: definition.aggregateType,
      aggregateId: event.aggregateId,
      aggregateVersion: event.aggregateVersion,
      correlationId: context.correlationId,
      causationId,
      payload: payload.value,
      publishedAt: null,
    };
  }
}

/**
 * `OutboxWriterFactory.forModule(name)` (P 5.2): the module's outbox model comes from the
 * model map. A module without an outbox table cannot bind a writer; boot fails.
 */
export class PrismaOutboxWriterFactory implements OutboxWriterFactory {
  constructor(
    private readonly map: ModelMap,
    private readonly prisma: PrismaService,
    private readonly catalogue: EventCatalogue,
    private readonly ids: IdGenerator,
    private readonly permissionKeys: PermissionKeyLookup,
  ) {}

  forModule(module: string): OutboxWriter {
    const outboxModel = this.map.modules[module]?.outboxModel ?? null;
    const entry = outboxModel === null ? undefined : this.map.models[outboxModel];
    if (entry === undefined || entry.module !== module) {
      throw new Error(`Module "${module}" has no outbox model in prisma/schema/${module}.prisma`);
    }
    return new PrismaOutboxWriter(
      module,
      entry.clientProperty,
      this.prisma,
      this.catalogue,
      this.ids,
      this.permissionKeys,
    );
  }
}
