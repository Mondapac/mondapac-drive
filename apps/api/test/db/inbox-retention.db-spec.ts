import { randomUUID } from 'node:crypto';
import { Temporal } from '@mondapac-drive/shared-kernel';
import { Client } from 'pg';
import { PrismaInboxPurger } from '../../src/platform/persistence/outbox/prisma-inbox-purger';
import { createPersistence, marketOf, modelMap, type Persistence } from './persistence-support';
import { testDatabaseUrl } from './test-database';

// platform.inbox-retention's purger (handoff 35) on the real schema, as the application role:
// it deletes handled rows older than the cut-off from every module inbox, of its own Market and
// tenant only, in batches of `limit`, and leaves newer rows alone. Rows are dated in 2000 so no
// other spec's rows (written at their clocks' 2026 instants) are ever before the cut-off.

const CUT_OFF = Temporal.Instant.from('2001-01-01T00:00:00Z');
const OLD = '2000-06-01T00:00:00Z';
const RECENT = '2001-06-01T00:00:00Z';
const INBOXES = Object.entries(modelMap.modules)
  .filter(([, entry]) => entry.inboxModel !== null)
  .map(([module, entry]) => ({ module, schema: modelMap.models[entry.inboxModel!]!.schema! }));

describe('PrismaInboxPurger (database integration)', () => {
  let db: Persistence;
  let sql: Client;
  let purger: PrismaInboxPurger;

  beforeAll(async () => {
    db = createPersistence();
    sql = new Client({ connectionString: testDatabaseUrl() });
    await sql.connect();
    purger = new PrismaInboxPurger(db.root, modelMap);
  });

  afterAll(async () => {
    await sql.end();
    await db.close();
  });

  async function insert(schema: string, code: string, handler: string, at: string, count = 1) {
    const market = marketOf(code);
    for (let index = 0; index < count; index += 1) {
      await sql.query(
        `INSERT INTO "${schema}"."inbox" (event_id, handler, market_id, tenant_id, processed_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [randomUUID(), handler, market.marketId, market.tenantId, at],
      );
    }
  }

  async function countOf(schema: string, handler: string): Promise<number> {
    const { rows } = await sql.query<{ n: string }>(
      `SELECT count(*) AS n FROM "${schema}"."inbox" WHERE handler = $1`,
      [handler],
    );
    return Number(rows[0]!.n);
  }

  it('covers every module inbox of the model map', () => {
    expect([...purger.modules].sort()).toEqual(INBOXES.map((inbox) => inbox.module).sort());
    expect(purger.modules).toEqual(
      expect.arrayContaining(['tracking', 'dispatch', 'notifications', 'fleet', 'payouts']),
    );
  });

  it.each(['AU', 'ZZ'])(
    'deletes old handled rows of %s in every inbox, never newer ones or another Market',
    async (code) => {
      const other = code === 'AU' ? 'ZZ' : 'AU';
      const handlers = new Map<string, string>();
      for (const { module, schema } of INBOXES) {
        const handler = `${module}.retention-spec-${randomUUID()}`;
        handlers.set(schema, handler);
        await insert(schema, code, handler, OLD, 3);
        await insert(schema, code, handler, RECENT, 2);
        await insert(schema, other, handler, OLD, 1);
      }

      const deleted = await purger.purgeHandled(marketOf(code), CUT_OFF, 1000);

      for (const { module, schema } of INBOXES) {
        // Only this spec's rows are dated before 2001.
        expect(deleted[module]).toBe(3);
        expect(await countOf(schema, handlers.get(schema)!)).toBe(3);
      }
      expect(await purger.purgeHandled(marketOf(code), CUT_OFF, 1000)).toEqual(
        Object.fromEntries(INBOXES.map(({ module }) => [module, 0])),
      );
      // Clean up the other Market's old rows for the next case.
      await purger.purgeHandled(marketOf(other), CUT_OFF, 1000);
    },
  );

  it('deletes at most `limit` rows per inbox and statement', async () => {
    const { module, schema } = INBOXES[0]!;
    const handler = `${module}.retention-spec-${randomUUID()}`;
    await insert(schema, 'AU', handler, OLD, 5);
    const first = await purger.purgeHandled(marketOf('AU'), CUT_OFF, 2);
    expect(first[module]).toBe(2);
    expect(await countOf(schema, handler)).toBe(3);
    await purger.purgeHandled(marketOf('AU'), CUT_OFF, 1000);
    expect(await countOf(schema, handler)).toBe(0);
  });
});
