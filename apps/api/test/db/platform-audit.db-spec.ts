import { randomBytes, randomUUID } from 'node:crypto';
import { devNull } from 'node:os';
import { Module, type INestApplicationContext } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Client } from 'pg';
import pino from 'pino';
import {
  auditField,
  defineAuditAction,
  err,
  ok,
  Temporal,
  uuidV7,
} from '@mondapac-drive/shared-kernel';
import type { CallContext, Id, MarketContext } from '@mondapac-drive/shared-kernel';
import {
  FixedClock,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac-drive/shared-kernel/testing';
import { AppModule } from '../../src/app.module';
import { registerAuditActions } from '../../src/platform/audit/audit-action-catalogue';
import {
  AUDIT_WRITER,
  AuditWriteRefusedError,
  type AuditWriter,
} from '../../src/platform/audit/audit-writer';
import { CLOCK } from '../../src/platform/clock/clock.module';
import { PLATFORM_TENANT_ID } from '../../src/platform/market-context/tenant';
import { auditTx } from '../../src/platform/persistence/audit/audit-transaction';
import { PersistenceModule } from '../../src/platform/persistence/persistence.module';
import { PrismaRoot } from '../../src/platform/persistence/prisma-root';
import { UNIT_OF_WORK, type UnitOfWork } from '../../src/platform/unit-of-work/unit-of-work';
import { testAppConfig, TEST_MARKETS } from '../support/test-config';
import { ownerTestDatabaseUrl, testDatabaseUrl } from './test-database';

// Identity slice 6a, database half of docs/design/domain/platform-audit.md 16 and the sign-off
// checklist of docs/design/data/platform.md 11.10: the audit writer in a real unit, and the
// migration `platform_audit_seal` (CHECKs, keys, foreign key, append-only triggers, grants).
// Every case runs for both Market fixtures. Only this file writes seals in the run database.

const CHECK_VIOLATION = '23514';
const UNIQUE_VIOLATION = '23505';
const FOREIGN_KEY_VIOLATION = '23503';
const RESTRICT_VIOLATION = '23001';
const INSUFFICIENT_PRIVILEGE = '42501';
const START = Temporal.Instant.from('2026-10-08T06:00:00.250Z');

/** A test owner's actions, registered only in this file's application graph. */
const thingChanged = defineAuditAction({
  action: 'alpha.thing.changed',
  targetType: 'alpha.thing',
  actors: ['authenticated', 'system'],
  before: { state: auditField.enumOf(['draft', 'live'] as const) },
  after: { state: auditField.enumOf(['draft', 'live'] as const) },
});
const linkAccepted = defineAuditAction({
  action: 'alpha.link.accepted',
  targetType: 'alpha.link',
  actors: ['anonymous'],
  after: { boundSubjectId: auditField.id() },
});

@Module({
  providers: [
    registerAuditActions('alpha', [thingChanged, linkAccepted]),
    PersistenceModule.auditWriterFor('alpha'),
  ],
  exports: [AUDIT_WRITER],
})
class AlphaAuditTestModule {}

const marketOf = (code: string) => testMarketContext(code, PLATFORM_TENANT_ID);
const otherOf = (code: string) => (code === 'AU' ? 'ZZ' : 'AU');
const correlation = () => `audit-db-${randomBytes(8).toString('hex')}`;
const hash = (length = 32) => randomBytes(length);
/** A UUIDv7, as the writer checks ids with the kernel's parser. */
const newId = <K extends string = string>() => uuidV7(Date.now(), randomBytes(10)) as Id<K>;

/** Runs one statement in a transaction that is always rolled back; answers its SQLSTATE. */
async function sqlStateOf(client: Client, statement: string, values: unknown[] = []) {
  await client.query('BEGIN');
  try {
    await client.query(statement, values);
    return 'ok';
  } catch (error) {
    return (error as { code?: string }).code ?? 'unknown';
  } finally {
    await client.query('ROLLBACK');
  }
}

/** The SQLSTATE and constraint of a statement that must fail; null if it succeeded. */
async function failureOf(promise: Promise<unknown>) {
  try {
    await promise;
    return null;
  } catch (error) {
    const { code, constraint } = error as { code?: string; constraint?: string };
    return { code, constraint };
  }
}

describe('platform audit writer and seal tables (database integration, slice 6a)', () => {
  const clock = new FixedClock(START);
  let app: INestApplicationContext;
  let writer: AuditWriter;
  let unitOfWork: UnitOfWork;
  let root: PrismaRoot;
  /** The application login. */
  let sql: Client;
  /** The owner of the run database: the migration role. */
  let owner: Client;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        AppModule.register({
          config: testAppConfig({ DATABASE_URL: testDatabaseUrl() }),
          logDestination: pino.destination(devNull),
        }),
        AlphaAuditTestModule,
      ],
    })
      .overrideProvider(CLOCK)
      .useValue(clock)
      .compile();
    app = await moduleRef.init();
    writer = app.select(AlphaAuditTestModule).get<AuditWriter>(AUDIT_WRITER, { strict: true });
    unitOfWork = app.get<UnitOfWork>(UNIT_OF_WORK);
    root = app.get(PrismaRoot);
    sql = new Client({ connectionString: testDatabaseUrl() });
    await sql.connect();
    owner = new Client({ connectionString: ownerTestDatabaseUrl() });
    await owner.connect();
  });

  afterAll(async () => {
    await owner.end();
    await sql.end();
    await app.close();
  });

  const rowsOf = (correlationId: string) =>
    root.auditLog.findMany({ where: { correlationId }, orderBy: { id: 'asc' } });

  /** An audit row inserted as the application login, as a writer-valid row would be stored. */
  async function auditRowAt(marketId: string, occurredAt: string, client: Client = sql) {
    const id = randomUUID();
    await client.query(
      `INSERT INTO platform.audit_log
         (id, market_id, tenant_id, occurred_at, actor_type, action, target_type, target_id, correlation_id)
       VALUES ($1, $2, $3, $4, 'SYSTEM', 'alpha.thing.changed', 'alpha.thing', $5, 'audit-db-seal-fixture')`,
      [id, marketId, PLATFORM_TENANT_ID, occurredAt, id],
    );
    return { id, occurredAt };
  }

  interface Seal {
    marketId: string;
    epoch: number;
    chainSeq: number | bigint;
    auditLogId: string;
    auditOccurredAt: string;
    late?: boolean;
    rowHash?: Buffer;
    chainHash?: Buffer;
    hashVersion?: number;
  }

  function insertSeal(seal: Seal, client: Client = sql) {
    return client.query(
      `INSERT INTO platform.audit_log_seal
         (market_id, tenant_id, epoch, chain_seq, audit_log_id, audit_occurred_at, row_hash,
          chain_hash, late, hash_version, sealed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        seal.marketId,
        PLATFORM_TENANT_ID,
        seal.epoch,
        String(seal.chainSeq),
        seal.auditLogId,
        seal.auditOccurredAt,
        seal.rowHash ?? hash(),
        seal.chainHash ?? hash(),
        seal.late ?? false,
        seal.hashVersion ?? 1,
        START.toString(),
      ],
    );
  }

  function insertCheckpoint(
    checkpoint: {
      marketId: string;
      epoch: number;
      chainSeq: number;
      chainHash?: Buffer;
      hashVersion?: number;
    },
    client: Client = sql,
  ) {
    return client.query(
      `INSERT INTO platform.audit_chain_checkpoint
         (market_id, tenant_id, epoch, chain_seq, chain_hash, hash_version, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        checkpoint.marketId,
        PLATFORM_TENANT_ID,
        checkpoint.epoch,
        checkpoint.chainSeq,
        checkpoint.chainHash ?? hash(),
        checkpoint.hashVersion ?? 1,
        START.toString(),
      ],
    );
  }

  // Seals outside the genesis test use their own epoch per test, so no two tests share a chain.
  let nextEpoch = 100;
  const freshEpoch = () => (nextEpoch += 1);

  describe.each(TEST_MARKETS)('the audit writer in market %s (PA 3.1)', (code) => {
    const market = marketOf(code);
    const system = (correlationId: string): CallContext =>
      testCallContext(market, 'system', correlationId);
    const target = () => newId();
    const changed = (id: Id) =>
      thingChanged.entry(id, { before: { state: 'draft' }, after: { state: 'live' } });

    it('commits its row with an ok unit: actor derived, whole milliseconds, context stamps', async () => {
      const correlationId = correlation();
      const account = newId<'Account'>();
      const context = testCallContext(
        market,
        testAuthenticatedActor(market, {
          population: 'admin',
          accountId: account,
          sessionId: newId<'Session'>(),
          sellerId: null,
        }),
        correlationId,
      );
      const id = target();

      const result = await unitOfWork.run(market, async () => {
        await writer.record(context, changed(id));
        return ok(undefined);
      });

      expect(result.ok).toBe(true);
      const rows = await rowsOf(correlationId);
      expect(rows).toEqual([
        {
          id: expect.any(String) as string,
          marketId: code,
          tenantId: PLATFORM_TENANT_ID,
          occurredAt: new Date('2026-10-08T06:00:00.250Z'),
          actorType: 'USER',
          actorId: account,
          actingAsId: null,
          action: 'alpha.thing.changed',
          targetType: 'alpha.thing',
          targetId: id,
          before: { state: 'draft' },
          after: { state: 'live' },
          correlationId,
        },
      ]);
    });

    it('writes nothing when the unit answers err or throws (W5, AC 11)', async () => {
      const failed = correlation();
      const thrown = correlation();

      const answer = await unitOfWork.run(market, async () => {
        await writer.record(system(failed), changed(target()));
        return err({ code: 'thing.refused' });
      });
      await expect(
        unitOfWork.run(market, async () => {
          await writer.record(system(thrown), changed(target()));
          throw new Error('the audited change failed');
        }),
      ).rejects.toThrow('the audited change failed');

      expect(answer.ok).toBe(false);
      await expect(rowsOf(failed)).resolves.toEqual([]);
      await expect(rowsOf(thrown)).resolves.toEqual([]);
    });

    it('rolls back the whole unit when it refuses, the change it audits included (W5)', async () => {
      const correlationId = correlation();

      await expect(
        unitOfWork.run(market, async () => {
          await writer.record(system(correlationId), changed(target()));
          await writer.record(
            system(correlationId),
            linkAccepted.entry(target(), { after: { boundSubjectId: target() } }),
          );
          return ok(undefined);
        }),
      ).rejects.toThrow(AuditWriteRefusedError);

      await expect(rowsOf(correlationId)).resolves.toEqual([]);
    });

    it('refuses a read-only unit and a unit of another Market (W1)', async () => {
      const correlationId = correlation();
      const reasons: string[] = [];
      for (const attempt of [
        () =>
          unitOfWork.run(
            market,
            async () => {
              await writer.record(system(correlationId), changed(target()));
              return ok(undefined);
            },
            { readOnly: true },
          ),
        () =>
          unitOfWork.run(marketOf(otherOf(code)), async () => {
            await writer.record(system(correlationId), changed(target()));
            return ok(undefined);
          }),
      ]) {
        await attempt().catch((error: unknown) => {
          reasons.push((error as AuditWriteRefusedError).reason);
        });
      }

      expect(reasons).toEqual(['read-only-unit', 'market-mismatch']);
      await expect(rowsOf(correlationId)).resolves.toEqual([]);
    });

    it('writes several rows in one unit (W6), in the Market of the unit only', async () => {
      const correlationId = correlation();

      await unitOfWork.run(market, async () => {
        await writer.record(system(correlationId), changed(target()));
        await writer.record(system(correlationId), changed(target()));
        return ok(undefined);
      });

      const rows = await rowsOf(correlationId);
      expect(rows.map((row) => [row.marketId, row.actorType])).toEqual([
        [code, 'SYSTEM'],
        [code, 'SYSTEM'],
      ]);
    });

    it('accepts an ANONYMOUS row that names its bound subject (W4a)', async () => {
      const correlationId = correlation();
      const subject = target();

      await unitOfWork.run(market, async () => {
        await writer.record(
          testCallContext(market, 'anonymous', correlationId),
          linkAccepted.entry(target(), { after: { boundSubjectId: subject } }),
        );
        return ok(undefined);
      });

      await expect(rowsOf(correlationId)).resolves.toMatchObject([
        { actorType: 'ANONYMOUS', actorId: null, after: { boundSubjectId: subject } },
      ]);
    });
  });

  describe.each(TEST_MARKETS)('platform.audit_log CHECKs in market %s (DP 11.2)', (code) => {
    const insert = (columns: Record<string, unknown>, client: Client = sql) => {
      const row = {
        id: randomUUID(),
        market_id: code,
        tenant_id: PLATFORM_TENANT_ID,
        occurred_at: '2026-10-08T06:00:00.000Z',
        actor_type: 'SYSTEM',
        action: 'alpha.thing.changed',
        target_type: 'alpha.thing',
        target_id: 'db-spec',
        correlation_id: 'audit-db-check-0001',
        ...columns,
      };
      const names = Object.keys(row);
      return client.query(
        `INSERT INTO platform.audit_log (${names.join(', ')})
         VALUES (${names.map((_, index) => `$${index + 1}`).join(', ')})`,
        Object.values(row),
      );
    };

    it('accepts ANONYMOUS and refuses ANONYMOUS with an actor id', async () => {
      await expect(insert({ actor_type: 'ANONYMOUS' })).resolves.toBeDefined();
      await expect(
        failureOf(insert({ actor_type: 'ANONYMOUS', actor_id: randomUUID() })),
      ).resolves.toEqual({ code: CHECK_VIOLATION, constraint: 'audit_log_actor_check' });
    });

    it('refuses a microsecond occurred_at, even from the owner (Hassan M2)', async () => {
      await expect(
        failureOf(insert({ occurred_at: '2026-10-08T06:00:00.000123Z' }, owner)),
      ).resolves.toEqual({ code: CHECK_VIOLATION, constraint: 'audit_log_occurred_at_check' });
      await expect(
        insert({ occurred_at: '2026-10-08T06:00:00.123Z' }, owner),
      ).resolves.toBeDefined();
    });

    it('accepts a 4 KB writer-valid array of small integers in before and after', async () => {
      // 2 045 zeros: 4 096 bytes of canonical JSON, about 6 142 bytes as jsonb text (DP 11.2).
      const value = JSON.stringify({ a: Array.from({ length: 2045 }, () => 0) });
      expect(value.length).toBeLessThanOrEqual(4100);

      await expect(insert({ before: value, after: value })).resolves.toBeDefined();
    });

    it.each(['before', 'after'] as const)(
      'refuses an oversize %s, a highly compressible one included (Hassan L3, I-a)',
      async (side) => {
        const long = JSON.stringify({ k: 'x'.repeat(8200) });
        const compressible = JSON.stringify({ a: Array.from({ length: 3000 }, () => 0) });

        for (const value of [long, compressible]) {
          await expect(failureOf(insert({ [side]: value }))).resolves.toEqual({
            code: CHECK_VIOLATION,
            constraint: `audit_log_${side}_size_check`,
          });
        }
      },
    );
  });

  describe('platform.audit_log_seal and platform.audit_chain_checkpoint (DP 11.3 to 11.5)', () => {
    it('starts an independent chain per Market at epoch 1, chain_seq 1', async () => {
      for (const code of TEST_MARKETS) {
        const row = await auditRowAt(code, '2026-10-08T05:00:00.000Z');
        await insertSeal({
          marketId: code,
          epoch: 1,
          chainSeq: 1,
          auditLogId: row.id,
          auditOccurredAt: row.occurredAt,
        });
        await insertCheckpoint({ marketId: code, epoch: 1, chainSeq: 1 });
      }

      const { rows } = await sql.query<{ market_id: string; chain_seq: string }>(
        'SELECT market_id, chain_seq FROM platform.audit_log_seal WHERE epoch = 1 ORDER BY 1',
      );
      expect(rows).toEqual([
        { market_id: 'AU', chain_seq: '1' },
        { market_id: 'ZZ', chain_seq: '1' },
      ]);
    });

    describe.each(TEST_MARKETS)('in market %s', (code) => {
      it("refuses a seal naming another Market's audit row or another time (23503)", async () => {
        const row = await auditRowAt(code, '2026-10-08T05:01:00.000Z');
        const epoch = freshEpoch();

        await expect(
          failureOf(
            insertSeal({
              marketId: otherOf(code),
              epoch,
              chainSeq: 1,
              auditLogId: row.id,
              auditOccurredAt: row.occurredAt,
            }),
          ),
        ).resolves.toEqual({
          code: FOREIGN_KEY_VIOLATION,
          constraint: 'audit_log_seal_market_id_audit_occurred_at_audit_log_id_fkey',
        });
        await expect(
          failureOf(
            insertSeal({
              marketId: code,
              epoch,
              chainSeq: 1,
              auditLogId: row.id,
              auditOccurredAt: '2026-10-08T05:01:00.001Z',
            }),
          ),
        ).resolves.toMatchObject({ code: FOREIGN_KEY_VIOLATION });
      });

      it('tells a taken chain position from a row sealed twice by the constraint (11.8)', async () => {
        const epoch = freshEpoch();
        const first = await auditRowAt(code, '2026-10-08T05:02:00.000Z');
        const second = await auditRowAt(code, '2026-10-08T05:02:00.001Z');
        await insertSeal({
          marketId: code,
          epoch,
          chainSeq: 1,
          auditLogId: first.id,
          auditOccurredAt: first.occurredAt,
        });

        // Another sealer took the same head: the primary key.
        await expect(
          failureOf(
            insertSeal({
              marketId: code,
              epoch,
              chainSeq: 1,
              auditLogId: second.id,
              auditOccurredAt: second.occurredAt,
            }),
          ),
        ).resolves.toEqual({ code: UNIQUE_VIOLATION, constraint: 'audit_log_seal_pkey' });
        // The same row sealed again in the same epoch: the per-epoch unique key.
        await expect(
          failureOf(
            insertSeal({
              marketId: code,
              epoch,
              chainSeq: 2,
              auditLogId: first.id,
              auditOccurredAt: first.occurredAt,
            }),
          ),
        ).resolves.toEqual({
          code: UNIQUE_VIOLATION,
          constraint: 'audit_log_seal_market_id_epoch_occurred_at_id_key',
        });
        // In the next epoch the same row may be sealed again (F13).
        await expect(
          insertSeal({
            marketId: code,
            epoch: epoch + 1000,
            chainSeq: 1,
            auditLogId: first.id,
            auditOccurredAt: first.occurredAt,
          }),
        ).resolves.toBeDefined();
      });

      it.each<[string, Partial<Seal>, string]>([
        ['epoch 0', { epoch: 0 }, 'audit_log_seal_epoch_check'],
        ['chain_seq 0', { chainSeq: 0 }, 'audit_log_seal_chain_seq_check'],
        [
          'a late first seal of epoch 1',
          { epoch: 1, chainSeq: 1, late: true },
          'audit_log_seal_genesis_check',
        ],
        ['a 31-byte row hash', { rowHash: hash(31) }, 'audit_log_seal_row_hash_check'],
        ['a 33-byte chain hash', { chainHash: hash(33) }, 'audit_log_seal_chain_hash_check'],
        ['hash version 2', { hashVersion: 2 }, 'audit_log_seal_hash_version_check'],
      ])('refuses a seal with %s (23514)', async (_case, overrides, constraint) => {
        const row = await auditRowAt(code, '2026-10-08T05:03:00.000Z');

        await expect(
          failureOf(
            insertSeal({
              marketId: code,
              epoch: freshEpoch(),
              chainSeq: 7,
              auditLogId: row.id,
              auditOccurredAt: row.occurredAt,
              ...overrides,
            }),
          ),
        ).resolves.toEqual({ code: CHECK_VIOLATION, constraint });
      });

      it('accepts a late first seal of a later epoch (it starts behind a watermark)', async () => {
        const row = await auditRowAt(code, '2026-10-08T05:04:00.000Z');

        await expect(
          insertSeal({
            marketId: code,
            epoch: freshEpoch(),
            chainSeq: 1,
            auditLogId: row.id,
            auditOccurredAt: row.occurredAt,
            late: true,
          }),
        ).resolves.toBeDefined();
      });

      it.each<[string, Record<string, unknown>, string]>([
        ['epoch 0', { epoch: 0 }, 'audit_chain_checkpoint_epoch_check'],
        ['chain_seq 0', { chainSeq: 0 }, 'audit_chain_checkpoint_chain_seq_check'],
        [
          'a 31-byte chain hash',
          { chainHash: hash(31) },
          'audit_chain_checkpoint_chain_hash_check',
        ],
        ['hash version 2', { hashVersion: 2 }, 'audit_chain_checkpoint_hash_version_check'],
        [
          'a lower-case Market id',
          { marketId: code.toLowerCase() },
          'audit_chain_checkpoint_market_id_check',
        ],
      ])('refuses a checkpoint with %s (23514)', async (_case, overrides, constraint) => {
        await expect(
          failureOf(
            insertCheckpoint({ marketId: code, epoch: freshEpoch(), chainSeq: 1, ...overrides }),
          ),
        ).resolves.toEqual({ code: CHECK_VIOLATION, constraint });
      });

      it('lets one of two sealers on the same head commit; the other gets 23505 or 55P03', async () => {
        const epoch = freshEpoch();
        const a = await auditRowAt(code, '2026-10-08T05:05:00.000Z');
        const b = await auditRowAt(code, '2026-10-08T05:05:00.001Z');
        const second = new Client({ connectionString: testDatabaseUrl() });
        await second.connect();
        try {
          await sql.query('BEGIN');
          await second.query('BEGIN');
          await insertSeal({
            marketId: code,
            epoch,
            chainSeq: 1,
            auditLogId: a.id,
            auditOccurredAt: a.occurredAt,
          });
          const loser = failureOf(
            insertSeal(
              {
                marketId: code,
                epoch,
                chainSeq: 1,
                auditLogId: b.id,
                auditOccurredAt: b.occurredAt,
              },
              second,
            ),
          );
          await sql.query('COMMIT');
          const outcome = await loser;
          await second.query('ROLLBACK');

          expect([UNIQUE_VIOLATION, '55P03']).toContain(outcome?.code);
          const { rows } = await sql.query(
            'SELECT audit_log_id FROM platform.audit_log_seal WHERE market_id = $1 AND epoch = $2',
            [code, epoch],
          );
          expect(rows).toEqual([{ audit_log_id: a.id }]);
        } finally {
          await second.end();
        }
      });
    });

    describe.each(['audit_log_seal', 'audit_chain_checkpoint'])(
      'platform.%s is append-only',
      (table) => {
        const name = `platform.${table}`;

        it('refuses the application everything but INSERT and SELECT (42501)', async () => {
          const statements = [
            `UPDATE ${name} SET tenant_id = tenant_id`,
            `DELETE FROM ${name}`,
            `TRUNCATE ${name}`,
            `SELECT 1 FROM ${name} FOR UPDATE`,
            `SELECT 1 FROM ${name} FOR SHARE`,
            `ALTER TABLE ${name} DISABLE TRIGGER ALL`,
            `LOCK TABLE ${name} IN ACCESS EXCLUSIVE MODE`,
            `DROP TABLE ${name}`,
          ];
          const states: Record<string, string> = {};
          for (const statement of statements) states[statement] = await sqlStateOf(sql, statement);

          expect(states).toEqual(
            Object.fromEntries(statements.map((statement) => [statement, INSUFFICIENT_PRIVILEGE])),
          );
          await expect(sqlStateOf(sql, `SELECT count(*) FROM ${name}`)).resolves.toBe('ok');
        });

        it('refuses its owner UPDATE, DELETE and TRUNCATE through the trigger (23001)', async () => {
          const statements = [
            `UPDATE ${name} SET tenant_id = tenant_id`,
            `DELETE FROM ${name}`,
            `TRUNCATE ${name}`,
          ];
          const states: Record<string, string> = {};
          for (const statement of statements)
            states[statement] = await sqlStateOf(owner, statement);

          expect(states).toEqual(
            Object.fromEntries(statements.map((statement) => [statement, RESTRICT_VIOLATION])),
          );
        });
      },
    );

    it('declares the foreign key ON DELETE and ON UPDATE RESTRICT, never CASCADE (Hassan I2)', async () => {
      const { rows } = await owner.query<{ action: string; deltype: string; updtype: string }>(
        `SELECT confdeltype AS deltype, confupdtype AS updtype, conname AS action
           FROM pg_constraint
          WHERE conname = 'audit_log_seal_market_id_audit_occurred_at_audit_log_id_fkey'`,
      );

      expect(rows).toEqual([
        {
          action: 'audit_log_seal_market_id_audit_occurred_at_audit_log_id_fkey',
          deltype: 'r',
          updtype: 'r',
        },
      ]);
    });
  });

  it('still lets the guarded client write and read through the unit (no regression of PM6)', async () => {
    const market: MarketContext = marketOf('ZZ');
    const correlationId = correlation();
    await unitOfWork.run(market, async () => {
      await writer.record(
        testCallContext(market, 'system', correlationId),
        thingChanged.entry(newId(), {
          before: { state: 'live' },
          after: { state: 'draft' },
        }),
      );
      return ok(undefined);
    });

    const read = await unitOfWork.run(
      market,
      async () =>
        ok(await auditTx(market).auditLog.findMany({ where: { marketId: 'ZZ', correlationId } })),
      { readOnly: true },
    );
    expect(read.ok && read.value.map((row) => row.actorType)).toEqual(['SYSTEM']);
  });
});
