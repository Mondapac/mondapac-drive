import { Logger } from '@nestjs/common';
import { defineEvent, err, eventField, ok, Temporal } from '@mondapac-drive/shared-kernel';
import type { CallContext } from '@mondapac-drive/shared-kernel';
import { FixedClock } from '@mondapac-drive/shared-kernel/testing';
import { Client } from 'pg';
import {
  DISPATCH_BATCH_SIZE,
  MAX_DELIVERY_ATTEMPTS,
  backOffSeconds,
  type EventDelivery,
} from '../../src/platform/events/event-delivery';
import {
  subscription,
  SubscriptionRegistry,
  type RegisteredSubscription,
  type SubscriberContext,
} from '../../src/platform/events/event-subscriptions';
import type { MarketConfig } from '../../src/platform/market-config/market-config';
import { MarketRegistry } from '../../src/platform/market-config/market-registry';
import { MarketContextFactory } from '../../src/platform/market-context/market-context.factory';
import { PLATFORM_TENANT_ID } from '../../src/platform/market-context/tenant';
import { auditTx } from '../../src/platform/persistence/audit/audit-transaction';
import { UnknownDeliveryError } from '../../src/platform/persistence/outbox/delivery-ledger';
import { InProcessEventBus } from '../../src/platform/persistence/outbox/in-process-event-bus';
import { PrismaEventDispatcher } from '../../src/platform/persistence/outbox/prisma-event-dispatcher';
import { PrismaOutboxRelay } from '../../src/platform/persistence/outbox/prisma-outbox-relay';
import { testMarketId, TEST_MARKETS } from '../support/test-config';
import { eventContext, deliveryWriter, thing, thingRecorded, writeEvents } from './outbox-support';
import {
  auditRow,
  createPersistence,
  marketOf,
  modelMap,
  otherMarketOf,
  type Persistence,
} from './persistence-support';
import { deliveryTestDatabaseUrl } from './test-database';

// Platform persistence design ("P") 6.3 to 6.5, the delivery side of the in-process bus (slice 3
// of delivery): fan-out through the relay's transaction, the dispatcher's claim and back-off,
// `runOnce` with delivery's inbox, the dead letter, and the delivery ledger, for both Market
// fixtures, as the application role. This file runs on its own copy of the run database
// (global-setup.ts): the dispatcher claims every due row of a Market.

/** The same type as {@link thingRecorded}, with a field its payload never carries. */
const thingRecordedElsewhere = defineEvent({
  type: thingRecorded.type,
  aggregateType: 'test-thing',
  payload: { thingId: eventField.id(), missing: eventField.id() },
});

/** Another delivery type, for a subscription whose name is reused for another event. */
const otherThing = defineEvent({
  type: 'delivery.test-other-thing.v1',
  aggregateType: 'test-thing',
  payload: { thingId: eventField.id() },
});

type Behaviour = 'consume' | 'throw' | 'skip' | 'forge' | 'other-market' | 'refuse';

interface Handled {
  readonly eventId: string;
  readonly attempt: number;
  readonly context: SubscriberContext;
  readonly thingId: unknown;
  readonly ran: boolean;
}

describe('event delivery (database integration)', () => {
  let db: Persistence;
  let sql: Client;
  let serial = 0;

  beforeAll(async () => {
    db = createPersistence({ databaseUrl: deliveryTestDatabaseUrl() });
    sql = new Client({ connectionString: deliveryTestDatabaseUrl() });
    await sql.connect();
  });

  afterAll(async () => {
    await sql.end();
    await db.close();
  });

  // Every test starts with no due row: what an earlier test left pending is set aside.
  afterEach(async () => {
    await sql.query(
      `UPDATE platform.event_delivery SET status = 'dead', dead_at = now(), error_code = 'test.set-aside'
        WHERE status = 'pending'`,
    );
  });

  /** A handler whose behaviour the test sets; it records what it was handed. */
  function recordingHandler(name: string) {
    const handled: Handled[] = [];
    const state = {
      behaviour: 'consume' as Behaviour,
      /** A slow handler: the work moves this clock on by this much. */
      slow: null as { clock: FixedClock; by: Temporal.Duration } | null,
      /** Run in order, one per consuming call, before its work (a slow or interleaved handler). */
      hooks: [] as (() => Promise<void>)[],
    };
    const entry = subscription({
      name,
      event: thingRecorded,
      handle: async (event, delivery: EventDelivery, context) => {
        const record = (ran: boolean) =>
          handled.push({
            eventId: event.eventId,
            attempt: delivery.attempt,
            context,
            thingId: event.payload.thingId,
            ran,
          });
        switch (state.behaviour) {
          case 'throw':
            record(false);
            throw new Error('handler down');
          case 'skip':
            record(false);
            return;
          case 'forge':
            record(false);
            await db.unitOfWork.runOnce(context.market, { ...delivery }, () =>
              Promise.resolve(ok(undefined)),
            );
            return;
          case 'other-market': {
            record(false);
            const other = marketOf(otherMarketOf(context.market.marketId));
            await db.unitOfWork.runOnce(other, delivery, () => Promise.resolve(ok(undefined)));
            return;
          }
          case 'refuse':
            record(false);
            await db.unitOfWork.runOnce(context.market, delivery, () =>
              Promise.resolve(err('refused')),
            );
            return;
          case 'consume': {
            let ran = false;
            if (state.slow !== null) state.slow.clock.advance(state.slow.by);
            await state.hooks.shift()?.();
            await db.unitOfWork.runOnce(context.market, delivery, async () => {
              ran = true;
              // The work of the use case: a state change in the same unit as the inbox row.
              await auditTx(context.market).auditLog.create({
                data: auditRow(context.market, {
                  targetId: String(event.payload.thingId),
                  correlationId: context.correlationId,
                }),
              });
              return ok(undefined);
            });
            record(ran);
          }
        }
      },
    });
    return { entry, handled, state };
  }

  function stackOf(
    subscriptions: readonly RegisteredSubscription[],
    clock: FixedClock,
    codes: readonly string[] = TEST_MARKETS,
  ) {
    const registry = new SubscriptionRegistry();
    registry.register('delivery', subscriptions);
    registry.seal();
    const markets = new MarketRegistry(
      new Map(codes.map((code) => [testMarketId(code), {} as MarketConfig] as const)),
    );
    const contexts = new MarketContextFactory(markets, PLATFORM_TENANT_ID);
    const bus = new InProcessEventBus(registry, clock);
    return {
      relay: new PrismaOutboxRelay(db.root, modelMap, markets, contexts, bus, clock),
      dispatcher: new PrismaEventDispatcher(db.root, markets, contexts, registry, clock),
    };
  }

  const uniqueName = (label: string) => `delivery.test-${label}-${++serial}`;
  const startClock = () => new FixedClock(Temporal.Now.instant());
  const seconds = (value: number) => Temporal.Duration.from({ seconds: value });

  async function relayAll(relay: PrismaOutboxRelay) {
    while ((await relay.runOnce()).published > 0);
  }

  async function writeThings(code: string, count: number): Promise<CallContext> {
    const context = eventContext(marketOf(code));
    const writer = deliveryWriter(db);
    await writeEvents(
      db,
      writer,
      context,
      Array.from({ length: count }, () => thing()),
    );
    return context;
  }

  const deliveriesOf = async (subscriber: string) =>
    (
      await sql.query<{
        event_id: string;
        market_id: string;
        status: string;
        attempts: number;
        error_code: string | null;
        next_attempt_at: Date;
        correlation_id: string;
        payload: Record<string, unknown>;
      }>(
        `SELECT event_id, market_id, status, attempts, error_code, next_attempt_at, correlation_id, payload
           FROM platform.event_delivery WHERE subscriber = $1 ORDER BY event_id`,
        [subscriber],
      )
    ).rows;

  const inboxOf = async (handler: string) =>
    (
      await sql.query<{ event_id: string; market_id: string }>(
        'SELECT event_id, market_id FROM delivery.inbox WHERE handler = $1 ORDER BY event_id',
        [handler],
      )
    ).rows;

  const auditRowsFor = async (correlationId: string) =>
    Number(
      (
        await sql.query<{ n: string }>(
          'SELECT count(*) AS n FROM platform.audit_log WHERE correlation_id = $1',
          [correlationId],
        )
      ).rows[0]!.n,
    );

  it('fans out one pending row per subscription in the relay transaction, and none for an event nobody takes', async () => {
    const clock = startClock();
    const first = recordingHandler(uniqueName('first'));
    const second = recordingHandler(uniqueName('second'));
    const { relay } = stackOf([first.entry, second.entry], clock);
    const contexts = await Promise.all(TEST_MARKETS.map((code) => writeThings(code, 2)));

    await relayAll(relay);

    for (const name of [first.entry.name, second.entry.name]) {
      const rows = await deliveriesOf(name);
      expect(rows).toHaveLength(2 * TEST_MARKETS.length);
      expect(rows.every((row) => row.status === 'pending' && row.attempts === 0)).toBe(true);
      for (const [index, code] of TEST_MARKETS.entries()) {
        const ofMarket = rows.filter((row) => row.market_id === code);
        expect(ofMarket).toHaveLength(2);
        expect(ofMarket.every((row) => row.correlation_id === contexts[index]!.correlationId)).toBe(
          true,
        );
        expect(ofMarket[0]!.payload).toMatchObject({ state: 'open', count: 2 });
      }
    }

    // A relay with no subscription to the type marks the rows published and writes nothing.
    const silent = await writeThings('AU', 1);
    await relayAll(stackOf([], clock).relay);
    const { rows } = await sql.query(
      `SELECT o.published_at, d.event_id AS delivered
         FROM delivery.outbox o LEFT JOIN platform.event_delivery d ON d.event_id = o.event_id
        WHERE o.correlation_id = $1`,
      [silent.correlationId],
    );
    expect(rows).toEqual([{ published_at: expect.any(Date) as unknown, delivered: null }]);
  });

  it.each(TEST_MARKETS)(
    '%s: delivers each row once with the system actor of its Market and the envelope correlation id',
    async (code) => {
      const clock = startClock();
      const handler = recordingHandler(uniqueName('consume'));
      const { relay, dispatcher } = stackOf([handler.entry], clock);
      const context = await writeThings(code, 3);
      await relayAll(relay);

      const pass = await dispatcher.runOnce();
      const again = await dispatcher.runOnce();

      expect(pass).toEqual({ claimed: 3, fullBatch: false });
      expect(again.claimed).toBe(0);
      expect(handler.handled).toHaveLength(3);
      for (const seen of handler.handled) {
        expect(seen.ran).toBe(true);
        expect(seen.attempt).toBe(1);
        expect(seen.context.market.marketId).toBe(code);
        expect(seen.context.actor).toMatchObject({ kind: 'system' });
        expect(seen.context.correlationId).toBe(context.correlationId);
      }
      const rows = await deliveriesOf(handler.entry.name);
      expect(rows.map((row) => [row.status, row.attempts, row.error_code])).toEqual([
        ['delivered', 1, null],
        ['delivered', 1, null],
        ['delivered', 1, null],
      ]);
      expect(await inboxOf(handler.entry.name)).toEqual(
        rows.map((row) => ({ event_id: row.event_id, market_id: code })),
      );
      expect(await auditRowsFor(context.correlationId)).toBe(3);
    },
  );

  it('runs the work once when a delivered row is handed out again (the inbox, ADR-0006 decision 5)', async () => {
    const clock = startClock();
    const handler = recordingHandler(uniqueName('once'));
    const { relay, dispatcher } = stackOf([handler.entry], clock);
    const context = await writeThings('ZZ', 1);
    await relayAll(relay);
    await dispatcher.runOnce();

    // As if the mark were lost after the work committed: the row is due again.
    await sql.query(
      `UPDATE platform.event_delivery SET status = 'pending', delivered_at = NULL, next_attempt_at = $2
        WHERE subscriber = $1`,
      [handler.entry.name, new Date(clock.now().epochMilliseconds)],
    );
    await dispatcher.runOnce();

    expect(handler.handled.map((seen) => seen.ran)).toEqual([true, false]);
    expect(await auditRowsFor(context.correlationId)).toBe(1);
    expect((await deliveriesOf(handler.entry.name))[0]).toMatchObject({
      status: 'delivered',
      attempts: 2,
    });
  });

  it.each(TEST_MARKETS)(
    '%s: a failed handler is retried after its back-off, then delivered',
    async (code) => {
      const clock = startClock();
      const handler = recordingHandler(uniqueName('retry'));
      const { relay, dispatcher } = stackOf([handler.entry], clock);
      await writeThings(code, 1);
      await relayAll(relay);
      handler.state.behaviour = 'throw';
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      try {
        await dispatcher.runOnce();
      } finally {
        warn.mockRestore();
      }

      const [failed] = await deliveriesOf(handler.entry.name);
      expect(failed).toMatchObject({
        status: 'pending',
        attempts: 1,
        error_code: 'delivery.handler-failed',
      });
      expect(failed!.next_attempt_at.getTime()).toBe(
        clock.now().epochMilliseconds + backOffSeconds(1) * 1000,
      );

      handler.state.behaviour = 'consume';
      clock.advance(seconds(backOffSeconds(1) - 1));
      expect((await dispatcher.runOnce()).claimed).toBe(0);
      clock.advance(seconds(1));
      expect((await dispatcher.runOnce()).claimed).toBe(1);

      expect(handler.handled.map((seen) => [seen.attempt, seen.ran])).toEqual([
        [1, false],
        [2, true],
      ]);
      expect((await deliveriesOf(handler.entry.name))[0]).toMatchObject({
        status: 'delivered',
        attempts: 2,
        error_code: null,
      });
    },
  );

  it.each([
    ['returns without runOnce', 'skip', 'delivery.not-consumed'],
    ['passes a copy of its delivery', 'forge', 'delivery.handler-failed'],
    ['passes its delivery with another Market', 'other-market', 'delivery.handler-failed'],
    ['has its work refused (rolled back)', 'refuse', 'delivery.not-consumed'],
  ] as const)(
    'a handler that %s has failed: nothing is recorded',
    async (_label, behaviour, code) => {
      const clock = startClock();
      const handler = recordingHandler(uniqueName(behaviour));
      const { relay, dispatcher } = stackOf([handler.entry], clock);
      await writeThings('AU', 1);
      await relayAll(relay);
      handler.state.behaviour = behaviour;
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      try {
        await dispatcher.runOnce();
        if (behaviour === 'forge' || behaviour === 'other-market') {
          expect(warn).toHaveBeenCalledWith(
            expect.objectContaining({
              msg: 'event-delivery.handler-failed',
              err: expect.any(UnknownDeliveryError) as unknown,
            }),
          );
        }
      } finally {
        warn.mockRestore();
      }

      expect((await deliveriesOf(handler.entry.name))[0]).toMatchObject({
        status: 'pending',
        attempts: 1,
        error_code: code,
      });
      expect(await inboxOf(handler.entry.name)).toEqual([]);
    },
  );

  it(`dead-letters a delivery after ${MAX_DELIVERY_ATTEMPTS} failed claims, with one alerting line`, async () => {
    const clock = startClock();
    const handler = recordingHandler(uniqueName('dead'));
    const { relay, dispatcher } = stackOf([handler.entry], clock);
    await writeThings('ZZ', 1);
    await relayAll(relay);
    handler.state.behaviour = 'throw';
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    try {
      for (let attempt = 1; attempt <= MAX_DELIVERY_ATTEMPTS + 2; attempt += 1) {
        await dispatcher.runOnce();
        clock.advance(seconds(3600));
      }
      expect(error).toHaveBeenCalledTimes(1);
      expect(error).toHaveBeenCalledWith(
        expect.objectContaining({
          msg: 'event-delivery.dead',
          alert: true,
          errorCode: 'delivery.handler-failed',
          subscriber: handler.entry.name,
          marketId: 'ZZ',
          attempt: MAX_DELIVERY_ATTEMPTS,
        }),
      );
      for (const [line] of [...warn.mock.calls, ...error.mock.calls]) {
        expect(line).not.toHaveProperty('payload');
      }
    } finally {
      warn.mockRestore();
      error.mockRestore();
    }

    expect(handler.handled).toHaveLength(MAX_DELIVERY_ATTEMPTS);
    expect((await deliveriesOf(handler.entry.name))[0]).toMatchObject({
      status: 'dead',
      attempts: MAX_DELIVERY_ATTEMPTS,
      error_code: 'delivery.handler-failed',
    });
  });

  it('dead-letters at once a delivery no retry can mend: unknown subscriber, other type, undecodable payload', async () => {
    const clock = startClock();
    const gone = recordingHandler(uniqueName('gone'));
    const moved = recordingHandler(uniqueName('moved'));
    const reshaped = recordingHandler(uniqueName('reshaped'));
    await writeThings('AU', 1);
    await relayAll(stackOf([gone.entry, moved.entry, reshaped.entry], clock).relay);
    // The next release: one subscription removed, one renamed onto another type, one reshaped.
    const { dispatcher } = stackOf(
      [
        subscription({
          name: moved.entry.name,
          event: otherThing,
          handle: () => Promise.resolve(),
        }),
        subscription({
          name: reshaped.entry.name,
          event: thingRecordedElsewhere,
          handle: () => Promise.resolve(),
        }),
      ],
      clock,
    );
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    try {
      await dispatcher.runOnce();
    } finally {
      error.mockRestore();
    }

    const deadCode = async (name: string) =>
      (await deliveriesOf(name)).map((r) => [r.status, r.error_code]);
    expect(await deadCode(gone.entry.name)).toEqual([['dead', 'delivery.unknown-subscriber']]);
    expect(await deadCode(moved.entry.name)).toEqual([['dead', 'delivery.type-mismatch']]);
    expect(await deadCode(reshaped.entry.name)).toEqual([['dead', 'delivery.payload-undecodable']]);
  });

  it.each(TEST_MARKETS)(
    '%s: gives back the rest of a batch whose lease ran short, without spending an attempt (Mojtaba F1)',
    async (code) => {
      const clock = startClock();
      const handler = recordingHandler(uniqueName('lease'));
      const { relay, dispatcher } = stackOf([handler.entry], clock);
      await writeThings(code, 3);
      await relayAll(relay);
      // Each handler takes 20 s: after one, the 30 s lease has no room for another 15 s budget.
      handler.state.slow = { clock, by: seconds(20) };
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      try {
        expect((await dispatcher.runOnce()).claimed).toBe(3);

        expect(warn).toHaveBeenCalledWith(
          expect.objectContaining({
            msg: 'event-delivery.lease-short',
            marketId: code,
            released: 2,
          }),
        );
        const rows = await deliveriesOf(handler.entry.name);
        expect(rows.map((row) => [row.status, row.attempts]).sort()).toEqual([
          ['delivered', 1],
          ['pending', 0],
          ['pending', 0],
        ]);
        // Given back as due now, so the next pass (here or elsewhere) takes them at once.
        for (const row of rows.filter((r) => r.status === 'pending')) {
          expect(row.next_attempt_at.getTime()).toBe(clock.now().epochMilliseconds);
        }

        await dispatcher.runOnce();
        await dispatcher.runOnce();
      } finally {
        warn.mockRestore();
      }

      const rows = await deliveriesOf(handler.entry.name);
      expect(rows.every((row) => row.status === 'delivered' && row.attempts === 1)).toBe(true);
      expect(handler.handled.map((seen) => seen.attempt)).toEqual([1, 1, 1]);
    },
  );

  it.each(TEST_MARKETS)(
    '%s: a give-back never undoes a later claim of the row, even one given back again (Mojtaba C1)',
    async (code) => {
      const clock = startClock();
      const start = clock.now();
      const handler = recordingHandler(uniqueName('aba'));
      const a = stackOf([handler.entry], clock);
      const b = stackOf([handler.entry], clock);
      await writeThings(code, 3);
      await relayAll(a.relay);
      // A claims all three rows (attempts 1, lease end start + 30 s). Its first handler
      // overruns by 35 s; meanwhile B claims all three again (attempts 2, lease end start + 95 s),
      // delivers one in 50 s and gives the other two back (attempts 1, due at start + 85 s).
      // A's own handler then finds its row handled, and A gives back its other two: their
      // attempts are 1 again, as A's claim returned them, but they are B's give-back now.
      handler.state.hooks.push(
        async () => {
          clock.advance(seconds(35));
          await b.dispatcher.runOnce();
        },
        () => {
          clock.advance(seconds(50));
          return Promise.resolve();
        },
      );
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      try {
        expect((await a.dispatcher.runOnce()).claimed).toBe(3);
      } finally {
        warn.mockRestore();
      }

      const rows = await deliveriesOf(handler.entry.name);
      // B delivered one row (attempt 2); A's own row is delivered by A or was B's. Every row B
      // gave back keeps B's give-back: without the lease-end guard, A's give-back would have
      // taken it to attempts 0 and moved its due time.
      expect(rows.filter((row) => row.status === 'delivered').map((row) => row.attempts)).toContain(
        2,
      );
      const pending = rows.filter((row) => row.status === 'pending');
      expect(pending.length).toBeGreaterThanOrEqual(1);
      for (const row of pending) {
        expect(row.attempts).toBe(1);
        expect(row.next_attempt_at.getTime()).toBe(start.add(seconds(85)).epochMilliseconds);
      }
      expect(rows.every((row) => row.attempts >= 1)).toBe(true);
      expect(handler.handled.map((seen) => seen.attempt)).toEqual([2, 1]);
    },
  );

  it('claims only rows of the Markets this stack hosts', async () => {
    const clock = startClock();
    const handler = recordingHandler(uniqueName('hosted'));
    await writeThings('ZZ', 1);
    await writeThings('AU', 1);
    await relayAll(stackOf([handler.entry], clock).relay);

    await stackOf([handler.entry], clock, ['AU']).dispatcher.runOnce();

    const rows = await deliveriesOf(handler.entry.name);
    expect(rows.map((row) => [row.market_id, row.status]).sort()).toEqual([
      ['AU', 'delivered'],
      ['ZZ', 'pending'],
    ]);
  });

  it('two dispatchers at once never hand one row out twice, and together deliver every row', async () => {
    const clock = startClock();
    const handler = recordingHandler(uniqueName('race'));
    const first = stackOf([handler.entry], clock);
    const second = stackOf([handler.entry], clock);
    for (const code of TEST_MARKETS) await writeThings(code, DISPATCH_BATCH_SIZE + 5);
    await relayAll(first.relay);

    const drain = async (dispatcher: PrismaEventDispatcher) => {
      while ((await dispatcher.runOnce()).claimed > 0);
    };
    await Promise.all([drain(first.dispatcher), drain(second.dispatcher)]);

    const seen = handler.handled.map((entry) => entry.eventId);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toHaveLength(TEST_MARKETS.length * (DISPATCH_BATCH_SIZE + 5));
    const rows = await deliveriesOf(handler.entry.name);
    expect(rows.every((row) => row.status === 'delivered' && row.attempts === 1)).toBe(true);
  });
});
