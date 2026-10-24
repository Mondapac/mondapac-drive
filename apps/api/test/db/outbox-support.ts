import { defineEvent, eventField, ok, Temporal } from '@mondapac-drive/shared-kernel';
import type {
  CallContext,
  DomainEvent,
  Id,
  MarketContext,
  PendingEvent,
} from '@mondapac-drive/shared-kernel';
import { testCallContext } from '@mondapac-drive/shared-kernel/testing';
import type { EventBus, RelayTransaction } from '../../src/platform/events/event-bus';
import { EventCatalogue } from '../../src/platform/events/event-catalogue';
import { NO_PERMISSION_KEYS, type OutboxWriter } from '../../src/platform/events/outbox-writer';
import { SystemClock } from '../../src/platform/clock/system-clock';
import { UuidV7IdGenerator } from '../../src/platform/ids/uuid-v7-id-generator';
import { PrismaOutboxWriterFactory } from '../../src/platform/persistence/outbox/prisma-outbox-writer';
import { modelMap, type Persistence } from './persistence-support';

/** A test-only delivery event: every field kind but `permissionKey` (no registry yet). */
export const thingRecorded = defineEvent({
  type: 'delivery.test-thing-recorded.v1',
  aggregateType: 'test-thing',
  payload: {
    thingId: eventField.id(),
    state: eventField.enumOf(['open', 'closed'] as const),
    count: eventField.integer(),
    flagged: eventField.boolean(),
    at: eventField.instant(),
    related: eventField.listOf(eventField.id()),
    parentId: eventField.optional(eventField.id()),
  },
});

/** A test-only event of another module, registered so that only the module check refuses it. */
export const sellerThing = defineEvent({
  type: 'sellers.test-thing-recorded.v1',
  aggregateType: 'test-thing',
  payload: { thingId: eventField.id() },
});

export const ids = new UuidV7IdGenerator(new SystemClock());
export const OCCURRED_AT = Temporal.Instant.from('2026-10-07T01:02:03.004Z');

export function testCatalogue(): EventCatalogue {
  const catalogue = new EventCatalogue();
  catalogue.register('delivery', [thingRecorded]);
  catalogue.register('sellers', [sellerThing]);
  catalogue.seal();
  return catalogue;
}

/** The delivery writer of one test process, as `PersistenceModule.outboxWriterFor('delivery')` binds it. */
export function deliveryWriter(db: Persistence, catalogue = testCatalogue()): OutboxWriter {
  return new PrismaOutboxWriterFactory(
    modelMap,
    db.service,
    catalogue,
    ids,
    NO_PERMISSION_KEYS,
  ).forModule('delivery');
}

/** A minted CallContext for the writer: the Market's system actor and a fresh correlation id. */
export function eventContext(market: MarketContext): CallContext {
  return testCallContext(market, 'system', `db-test-${ids.next()}`);
}

/** A valid PendingEvent of {@link thingRecorded} for a new aggregate. */
export function thing(
  version = 1,
  thingId: Id = ids.next(),
  overrides: Partial<PendingEvent> = {},
): PendingEvent {
  return {
    ...thingRecorded.record({
      aggregateId: thingId,
      aggregateVersion: version,
      occurredAt: OCCURRED_AT,
      payload: {
        thingId,
        state: 'open',
        count: 2,
        flagged: false,
        at: OCCURRED_AT,
        related: [],
        parentId: null,
      },
    }),
    ...overrides,
  };
}

/** Writes events in one read-write unit of `context.market`, as a use case does. */
export async function writeEvents(
  db: Persistence,
  writer: OutboxWriter,
  context: CallContext,
  events: readonly PendingEvent[],
): Promise<void> {
  await db.unitOfWork.run(context.market, async () => {
    await writer.append(context, events);
    return ok(undefined);
  });
}

/** A bus that records what it is given; it may fail before or after recording (P 13). */
export class RecordingBus implements EventBus {
  readonly published: DomainEvent[] = [];
  failure: 'none' | 'before-publish' | 'after-publish' = 'none';

  publish(events: readonly DomainEvent[], transaction: RelayTransaction): Promise<void> {
    void transaction;
    if (this.failure === 'before-publish') return Promise.reject(new Error('bus down'));
    this.published.push(...events);
    if (this.failure === 'after-publish') return Promise.reject(new Error('aborted after publish'));
    return Promise.resolve();
  }
}
