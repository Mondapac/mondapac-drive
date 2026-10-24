import { createServer } from 'node:net';
import { devNull } from 'node:os';
import { Logger } from '@nestjs/common';
import { isMinted, ok, Temporal } from '@mondapac-drive/shared-kernel';
import type { DomainEvent } from '@mondapac-drive/shared-kernel';
import { FixedClock } from '@mondapac-drive/shared-kernel/testing';
import { Client } from 'pg';
import pino from 'pino';
import { SystemClock } from '../../src/platform/clock/system-clock';
import { RELAY_BATCH_SIZE } from '../../src/platform/events/event-bus';
import type { OutboxWriter } from '../../src/platform/events/outbox-writer';
import type { MarketConfig } from '../../src/platform/market-config/market-config';
import { MarketRegistry } from '../../src/platform/market-config/market-registry';
import { MarketContextFactory } from '../../src/platform/market-context/market-context.factory';
import { PLATFORM_TENANT_ID } from '../../src/platform/market-context/tenant';
import { auditTx } from '../../src/platform/persistence/audit/audit-transaction';
import { PrismaOutboxRelay } from '../../src/platform/persistence/outbox/prisma-outbox-relay';
import { startApi } from '../../src/start-api';
import { startWorker } from '../../src/start-worker';
import { testAppConfig, testMarketId, TEST_MARKETS } from '../support/test-config';
import {
  eventContext,
  deliveryWriter,
  ids,
  RecordingBus,
  thing,
  writeEvents,
} from './outbox-support';
import {
  auditRow,
  createPersistence,
  marketOf,
  modelMap,
  type Persistence,
} from './persistence-support';
import { relayTestDatabaseUrl } from './test-database';

// Platform persistence design ("P") 6 and the rows "Relay", "Crash between commit and
// publish" and "Roles" of 13, for both Market fixtures, as the application role. This file
// runs on its own copy of the run database (global-setup.ts): the relay claims every
// unpublished row of a Market, and the worker started at the end relays too.

const pinoNull = () => pino.destination(devNull);

function marketsOf(codes: readonly string[]) {
  const registry = new MarketRegistry(
    new Map(codes.map((code) => [testMarketId(code), {} as MarketConfig] as const)),
  );
  return { registry, contexts: new MarketContextFactory(registry, PLATFORM_TENANT_ID) };
}

describe('relay (database integration)', () => {
  let db: Persistence;
  let writer: OutboxWriter;
  let sql: Client;

  beforeAll(async () => {
    db = createPersistence({ databaseUrl: relayTestDatabaseUrl() });
    writer = deliveryWriter(db);
    sql = new Client({ connectionString: relayTestDatabaseUrl() });
    await sql.connect();
  });

  afterAll(async () => {
    await sql.end();
    await db.close();
  });

  function relayWith(
    bus: RecordingBus,
    codes: readonly string[] = TEST_MARKETS,
    clock = new SystemClock(),
  ) {
    const { registry, contexts } = marketsOf(codes);
    return new PrismaOutboxRelay(db.root, modelMap, registry, contexts, bus, clock);
  }

  /** Runs passes until one publishes nothing. */
  async function drain(relay: PrismaOutboxRelay): Promise<void> {
    while ((await relay.runOnce()).published > 0);
  }

  const publishedAtOf = async (eventIds: readonly string[]) =>
    (
      await sql.query<{ event_id: string; published_at: Date | null }>(
        'SELECT event_id, published_at FROM delivery.outbox WHERE event_id = ANY($1::uuid[])',
        [eventIds],
      )
    ).rows;

  const eventIdsOf = async (correlationId: string) =>
    (
      await sql.query<{ event_id: string }>(
        'SELECT event_id FROM delivery.outbox WHERE correlation_id = $1 ORDER BY event_id',
        [correlationId],
      )
    ).rows.map((row) => row.event_id);

  const ofCorrelation = (events: readonly DomainEvent[], correlationId: string) =>
    events.filter((event) => event.correlationId === correlationId);

  it('hands each row to the bus once, with its own Market, and marks it published', async () => {
    const contexts = Object.fromEntries(
      TEST_MARKETS.map((code) => [code, eventContext(marketOf(code))] as const),
    );
    await writeEvents(db, writer, contexts.AU!, [thing(), thing(), thing()]);
    await writeEvents(db, writer, contexts.ZZ!, [thing(), thing()]);
    const bus = new RecordingBus();
    const relay = relayWith(bus);

    await drain(relay);
    await drain(relay);

    for (const code of TEST_MARKETS) {
      const context = contexts[code]!;
      const seen = ofCorrelation(bus.published, context.correlationId);
      const written = await eventIdsOf(context.correlationId);
      expect(seen.map((event) => event.eventId).sort()).toEqual(written);
      expect(seen.every((event) => event.market.marketId === code)).toBe(true);
      expect(seen.every((event) => isMinted(event.market))).toBe(true);
      expect(seen.every((event) => event.market.tenantId === PLATFORM_TENANT_ID)).toBe(true);
      expect(seen.every((event) => event.type === 'delivery.test-thing-recorded.v1')).toBe(true);
      expect((await publishedAtOf(written)).every((row) => row.published_at !== null)).toBe(true);
    }
  });

  it('reads back the envelope the writer stamped', async () => {
    const context = eventContext(marketOf('ZZ'));
    const cause = ids.next<'event'>();
    const event = thing(3);
    await db.unitOfWork.run(context.market, async () => {
      await writer.append(context, [event], cause);
      return ok(undefined);
    });
    const bus = new RecordingBus();

    await drain(relayWith(bus));

    const [published] = ofCorrelation(bus.published, context.correlationId);
    expect(published).toMatchObject({
      type: event.type,
      aggregateType: 'test-thing',
      aggregateId: event.aggregateId,
      aggregateVersion: 3,
      correlationId: context.correlationId,
      causationId: cause,
      payload: { thingId: event.aggregateId, at: '2026-10-07T01:02:03.004Z', parentId: null },
    });
    expect(published!.occurredAt.equals(event.occurredAt)).toBe(true);
  });

  it('two relays at once never publish one row twice, and together publish every row', async () => {
    const contexts = TEST_MARKETS.map((code) => eventContext(marketOf(code)));
    for (const context of contexts) {
      const events = Array.from({ length: 2 * RELAY_BATCH_SIZE + 20 }, () => thing());
      await writeEvents(db, writer, context, events);
    }
    const first = new RecordingBus();
    const second = new RecordingBus();

    await Promise.all([drain(relayWith(first)), drain(relayWith(second))]);

    for (const context of contexts) {
      const seen = [
        ...ofCorrelation(first.published, context.correlationId),
        ...ofCorrelation(second.published, context.correlationId),
      ].map((event) => event.eventId);
      expect(new Set(seen).size).toBe(seen.length);
      expect(seen.sort()).toEqual(await eventIdsOf(context.correlationId));
    }
  });

  describe('crash between commit and publish (P 6.2; no loss, at least once)', () => {
    /** A use case: a state change (an audit row) and its event, committed in one unit. */
    async function commitStateChangeWithEvent(code: string) {
      const context = eventContext(marketOf(code));
      const event = thing();
      await db.unitOfWork.run(context.market, async () => {
        await auditTx(context.market).auditLog.create({ data: auditRow(context.market) });
        await writer.append(context, [event]);
        return ok(undefined);
      });
      const [eventId] = await eventIdsOf(context.correlationId);
      return { context, eventId: eventId! };
    }

    it.each(TEST_MARKETS)(
      '%s: relay A whose bus throws leaves the row unpublished; relay B publishes it once',
      async (code) => {
        const { context, eventId } = await commitStateChangeWithEvent(code);
        const busA = new RecordingBus();
        busA.failure = 'before-publish';

        await expect(relayWith(busA).runOnce()).rejects.toThrow('bus down');
        expect(await publishedAtOf([eventId])).toEqual([{ event_id: eventId, published_at: null }]);

        const busB = new RecordingBus();
        await drain(relayWith(busB));
        await drain(relayWith(busB));

        expect(ofCorrelation(busB.published, context.correlationId).map((e) => e.eventId)).toEqual([
          eventId,
        ]);
        expect((await publishedAtOf([eventId]))[0]!.published_at).not.toBeNull();
      },
    );

    it.each(TEST_MARKETS)(
      '%s: relay A aborted after publish rolls back the mark; B publishes again, with the same eventId',
      async (code) => {
        const { context, eventId } = await commitStateChangeWithEvent(code);
        const bus = new RecordingBus();
        bus.failure = 'after-publish';

        await expect(relayWith(bus).runOnce()).rejects.toThrow('aborted after publish');
        expect((await publishedAtOf([eventId]))[0]!.published_at).toBeNull();

        bus.failure = 'none';
        await drain(relayWith(bus));

        expect(ofCorrelation(bus.published, context.correlationId).map((e) => e.eventId)).toEqual([
          eventId,
          eventId,
        ]);
        expect((await publishedAtOf([eventId]))[0]!.published_at).not.toBeNull();
      },
    );
  });

  it('never claims rows of a Market this stack does not host, and reports that Market', async () => {
    const zz = eventContext(marketOf('ZZ'));
    await writeEvents(db, writer, zz, [thing()]);
    const bus = new RecordingBus();
    const auOnly = relayWith(bus, ['AU']);

    await drain(auOnly);

    expect(ofCorrelation(bus.published, zz.correlationId)).toEqual([]);
    await expect(auOnly.unhostedMarketsWithRows()).resolves.toEqual(['ZZ']);
    await drain(relayWith(new RecordingBus()));
    await expect(auOnly.unhostedMarketsWithRows()).resolves.toEqual([]);
  });

  it('logs the age of the oldest claimed row when above 5 s, without its payload', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      const context = eventContext(marketOf('AU'));
      await writeEvents(db, writer, context, [thing()]);
      const late = new FixedClock(Temporal.Instant.from('2026-10-07T01:02:09.005Z'));

      await drain(relayWith(new RecordingBus(), TEST_MARKETS, late));

      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ msg: 'outbox.lagging', marketId: 'AU', module: 'delivery' }),
      );
      for (const [line] of warn.mock.calls) expect(line).not.toHaveProperty('payload');
    } finally {
      warn.mockRestore();
    }
  });

  describe('roles: both boot through the real start functions (P 8)', () => {
    // A port the OS reports free: a random pick in 40000-60000 overlapped the ephemeral range
    // (32768-60999) and collided on a CI runner (EADDRINUSE).
    const freePort = (): Promise<number> =>
      new Promise((resolve, reject) => {
        const server = createServer();
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
          const address = server.address();
          const port = typeof address === 'object' && address !== null ? address.port : 0;
          server.close(() => resolve(port));
        });
      });
    const config = async (role: 'api' | 'worker') =>
      testAppConfig({
        APP_ROLE: role,
        DATABASE_URL: relayTestDatabaseUrl(),
        PORT: String(await freePort()),
      });

    it('api: listens and answers, and starts no relay', async () => {
      const context = eventContext(marketOf('AU'));
      await writeEvents(db, writer, context, [thing()]);
      const apiConfig = await config('api');
      const app = await startApi(apiConfig, { logDestination: pinoNull() });
      try {
        expect(app).toBeDefined();
        const response = await fetch(`http://127.0.0.1:${apiConfig.port}/health/ready`);
        expect(response.status).toBe(200);
        await new Promise((resolve) => setTimeout(resolve, 1200));
        const [eventId] = await eventIdsOf(context.correlationId);
        expect((await publishedAtOf([eventId!]))[0]!.published_at).toBeNull();
      } finally {
        await app?.close();
      }
    });

    it('worker: opens no port, relays what is unpublished, and stops within the grace', async () => {
      const context = eventContext(marketOf('ZZ'));
      await writeEvents(db, writer, context, [thing()]);
      const [eventId] = await eventIdsOf(context.correlationId);

      const worker = await startWorker(await config('worker'), { logDestination: pinoNull() });
      try {
        expect(worker).toBeDefined();
        expect('getHttpServer' in worker!.context).toBe(false);
        const deadline = Date.now() + 5000;
        let publishedAt: Date | null = null;
        while (publishedAt === null && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 100));
          publishedAt = (await publishedAtOf([eventId!]))[0]!.published_at;
        }
        expect(publishedAt).not.toBeNull();
      } finally {
        const started = Date.now();
        await worker?.stop();
        expect(Date.now() - started).toBeLessThan(10_500);
      }
    });
  });
});
