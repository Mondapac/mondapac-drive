import { err, ok, parseId } from '@mondapac-drive/shared-kernel';
import type { Id, PendingEvent } from '@mondapac-drive/shared-kernel';
import { Client } from 'pg';
import {
  OutboxWriteRefusedError,
  type OutboxWriter,
} from '../../src/platform/events/outbox-writer';
import {
  MarketGuardError,
  MarketMismatchError,
  NoUnitOfWorkError,
} from '../../src/platform/unit-of-work/errors';
import { TEST_MARKETS } from '../support/test-config';
import {
  eventContext,
  deliveryWriter,
  ids,
  OCCURRED_AT,
  sellerThing,
  thing,
  thingRecorded,
  writeEvents,
} from './outbox-support';
import {
  createPersistence,
  marketOf,
  otherMarketOf,
  type Persistence,
} from './persistence-support';
import { testDatabaseUrl } from './test-database';

// Platform persistence design ("P") 5.1 and 5.2 and the row "Outbox" of 13, for both Market
// fixtures, as the application role: an `err` unit leaves no row; the writer stamps what P 5.1
// says; an undeclared field, another module's type and a ZZ context in an AU unit are refused,
// and so are a read-only unit and no unit at all. "No row written" is read on the application
// login outside any unit.

interface OutboxRow {
  event_id: string;
  type: string;
  occurred_at: Date;
  market_id: string;
  tenant_id: string;
  aggregate_type: string;
  aggregate_id: string;
  aggregate_version: number;
  correlation_id: string;
  causation_id: string | null;
  payload: unknown;
  published_at: Date | null;
}

describe('outbox writer (database integration)', () => {
  let db: Persistence;
  let writer: OutboxWriter;
  let sql: Client;

  beforeAll(async () => {
    db = createPersistence();
    writer = deliveryWriter(db);
    sql = new Client({ connectionString: testDatabaseUrl() });
    await sql.connect();
  });

  afterAll(async () => {
    await sql.end();
    await db.close();
  });

  const rowsOf = async (aggregateId: string): Promise<OutboxRow[]> =>
    (
      await sql.query<OutboxRow>(
        'SELECT * FROM delivery.outbox WHERE aggregate_id = $1 ORDER BY aggregate_version',
        [aggregateId],
      )
    ).rows;

  describe.each(TEST_MARKETS)('in a unit for %s', (code) => {
    const market = marketOf(code);

    it('stamps event id, Market, tenant and correlation id; keeps what the aggregate recorded', async () => {
      const context = eventContext(market);
      const thingId = ids.next();
      const parentId = ids.next();
      const event = thingRecorded.record({
        aggregateId: thingId,
        aggregateVersion: 1,
        occurredAt: OCCURRED_AT,
        payload: {
          thingId,
          state: 'closed',
          count: 7,
          flagged: true,
          at: OCCURRED_AT,
          related: [parentId],
          parentId,
        },
      });

      await writeEvents(db, writer, context, [event]);

      const [row, ...rest] = await rowsOf(thingId);
      expect(rest).toEqual([]);
      expect(parseId(row!.event_id).ok).toBe(true);
      expect(row).toEqual({
        event_id: row!.event_id,
        type: 'delivery.test-thing-recorded.v1',
        occurred_at: new Date('2026-10-07T01:02:03.004Z'),
        market_id: code,
        tenant_id: market.tenantId,
        aggregate_type: 'test-thing',
        aggregate_id: thingId,
        aggregate_version: 1,
        correlation_id: context.correlationId,
        causation_id: null,
        payload: {
          thingId,
          state: 'closed',
          count: 7,
          flagged: true,
          at: '2026-10-07T01:02:03.004Z',
          related: [parentId],
          parentId,
        },
        published_at: null,
      });
    });

    it('writes one row per event, each with its own event id, and the causation id it was given', async () => {
      const context = eventContext(market);
      const thingId = ids.next();
      const cause = ids.next<'event'>();

      await db.unitOfWork.run(market, async () => {
        await writer.append(context, [thing(1, thingId), thing(2, thingId)], cause);
        return ok(undefined);
      });

      const rows = await rowsOf(thingId);
      expect(rows.map((row) => row.aggregate_version)).toEqual([1, 2]);
      expect(new Set(rows.map((row) => row.event_id)).size).toBe(2);
      expect(rows.every((row) => row.causation_id === cause)).toBe(true);
    });

    it('leaves no row when the unit returns err or throws', async () => {
      const context = eventContext(market);
      const thingId = ids.next();

      const result = await db.unitOfWork.run(market, async () => {
        await writer.append(context, [thing(1, thingId)]);
        return err({ code: 'refused' });
      });
      const thrown = db.unitOfWork.run(market, async () => {
        await writer.append(context, [thing(1, thingId)]);
        throw new Error('the use case failed after appending');
      });

      expect(result).toEqual({ ok: false, error: { code: 'refused' } });
      await expect(thrown).rejects.toThrow('the use case failed after appending');
      await expect(rowsOf(thingId)).resolves.toEqual([]);
    });

    const refusals: [string, (thingId: Id) => PendingEvent, string, string | null][] = [
      [
        'an undeclared payload field',
        (id) => ({ ...thing(1, id), payload: { ...thing(1, id).payload, reason: 'free text' } }),
        'payload-invalid',
        null,
      ],
      [
        'a field of the wrong kind',
        (id) => ({ ...thing(1, id), payload: { ...thing(1, id).payload, count: '2' } }),
        'payload-invalid',
        'count',
      ],
      [
        "another module's type",
        (id) =>
          sellerThing.record({
            aggregateId: id,
            aggregateVersion: 1,
            occurredAt: OCCURRED_AT,
            payload: { thingId: id },
          }),
        'type-of-another-module',
        null,
      ],
      [
        'a type of its module that is not in the catalogue',
        (id) => thing(1, id, { type: 'delivery.test-thing-recorded.v2' }),
        'type-not-in-catalogue',
        null,
      ],
      [
        'another aggregate type than the definition',
        (id) => thing(1, id, { aggregateType: 'account' }),
        'aggregate-type-mismatch',
        null,
      ],
      ['version 0', (id) => thing(1, id, { aggregateVersion: 0 }), 'version-out-of-range', null],
      [
        'version 2^31',
        (id) => thing(1, id, { aggregateVersion: 2 ** 31 }),
        'version-out-of-range',
        null,
      ],
      [
        'a malformed aggregate id',
        (id) => thing(1, id, { aggregateId: 'not-an-id' as Id }),
        'aggregate-id-invalid',
        null,
      ],
    ];

    it.each(refusals)(
      'refuses %s, rolls the unit back and writes no row',
      async (_case, eventOf, reason, field) => {
        const thingId = ids.next();
        const context = eventContext(market);

        const run = db.unitOfWork.run(market, async () => {
          await writer.append(context, [thing(1, ids.next()), eventOf(thingId)]);
          return ok(undefined);
        });

        await expect(run).rejects.toBeInstanceOf(OutboxWriteRefusedError);
        await expect(run).rejects.toMatchObject({ reason, field });
        // An undeclared key is caller data: neither the field nor the message echoes it (L2).
        await expect(run).rejects.not.toHaveProperty('message', expect.stringContaining('reason)'));
        const count = await sql.query('SELECT 1 FROM delivery.outbox WHERE correlation_id = $1', [
          context.correlationId,
        ]);
        expect(count.rowCount).toBe(0);
      },
    );

    it("refuses the other fixture's context in this Market's unit, and writes no row", async () => {
      const foreign = eventContext(marketOf(otherMarketOf(code)));

      const run = db.unitOfWork.run(market, async () => {
        await writer.append(foreign, [thing()]);
        return ok(undefined);
      });

      await expect(run).rejects.toBeInstanceOf(MarketMismatchError);
      const count = await sql.query('SELECT 1 FROM delivery.outbox WHERE correlation_id = $1', [
        foreign.correlationId,
      ]);
      expect(count.rowCount).toBe(0);
    });

    it('refuses to run in a read-only unit, and with no unit at all', async () => {
      const context = eventContext(market);

      const readOnly = db.unitOfWork.run(
        market,
        async () => {
          await writer.append(context, [thing()]);
          return ok(undefined);
        },
        { readOnly: true },
      );

      await expect(readOnly).rejects.toMatchObject({
        name: 'OutboxWriteRefusedError',
        reason: 'read-only-unit',
      });
      await expect(writer.append(context, [thing()])).rejects.toBeInstanceOf(NoUnitOfWorkError);
    });

    it('refuses a context that was not minted, and a malformed causation id', async () => {
      // A copy with another correlation id: the writer takes only the minted CallContext.
      const forged = { ...eventContext(market), correlationId: 'short' } as never;
      const copied = { ...eventContext(market) } as never;
      const run = (call: () => Promise<void>) =>
        db.unitOfWork.run(market, async () => {
          await call();
          return ok(undefined);
        });

      for (const context of [forged, copied]) {
        await expect(run(() => writer.append(context, [thing()]))).rejects.toMatchObject({
          reason: 'context-not-minted',
        });
      }
      await expect(
        run(() => writer.append(eventContext(market), [thing()], 'nope' as Id)),
      ).rejects.toMatchObject({ reason: 'causation-id-invalid' });
    });

    it('is refused by the database for a repeated aggregate version (I7)', async () => {
      const thingId = ids.next();
      await writeEvents(db, writer, eventContext(market), [thing(1, thingId)]);

      await expect(
        writeEvents(db, writer, eventContext(market), [thing(1, thingId)]),
      ).rejects.toMatchObject({ code: 'P2002' });
      expect(await rowsOf(thingId)).toHaveLength(1);
    });

    it('cannot be bypassed: the guard refuses an outbox row of the other Market written directly', async () => {
      const row = {
        eventId: ids.next(),
        type: thingRecorded.type,
        occurredAt: new Date(OCCURRED_AT.epochMilliseconds),
        marketId: otherMarketOf(code),
        tenantId: market.tenantId,
        aggregateType: 'test-thing',
        aggregateId: ids.next(),
        aggregateVersion: 1,
        correlationId: 'db-test-correlation-0001',
        payload: {},
      };

      const run = db.unitOfWork.run(market, async () => {
        const view = db.service.tx(market) as unknown as Record<
          string,
          { create(args: unknown): Promise<unknown> }
        >;
        await view.deliveryOutbox!.create({ data: row });
        return ok(undefined);
      });

      await expect(run).rejects.toBeInstanceOf(MarketGuardError);
    });
  });

  describe('the application role on delivery.outbox (PM2)', () => {
    it('may set published_at only: changing the envelope or deleting fails with 42501', async () => {
      const thingId = ids.next();
      await writeEvents(db, writer, eventContext(marketOf('AU')), [thing(1, thingId)]);
      const stateOf = async (statement: string) => {
        await sql.query('BEGIN');
        try {
          await sql.query(statement, [thingId]);
          return 'ok';
        } catch (error) {
          return (error as { code?: string }).code;
        } finally {
          await sql.query('ROLLBACK');
        }
      };

      expect(
        await stateOf(
          `UPDATE delivery.outbox SET published_at = '2026-10-07T00:00:00Z' WHERE aggregate_id = $1`,
        ),
      ).toBe('ok');
      expect(
        await stateOf(`UPDATE delivery.outbox SET payload = '{}' WHERE aggregate_id = $1`),
      ).toBe('42501');
      expect(await stateOf('DELETE FROM delivery.outbox WHERE aggregate_id = $1')).toBe('42501');
    });
  });
});
