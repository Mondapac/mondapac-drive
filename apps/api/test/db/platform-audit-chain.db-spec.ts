import { randomBytes } from 'node:crypto';
import { devNull } from 'node:os';
import { Logger, type INestApplicationContext } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Client } from 'pg';
import pino from 'pino';
import { ok, Temporal, uuidV7 } from '@mondapac-drive/shared-kernel';
import type { MarketContext } from '@mondapac-drive/shared-kernel';
import {
  FixedClock,
  testCallContext,
  testMarketContext,
} from '@mondapac-drive/shared-kernel/testing';
import { AppModule } from '../../src/app.module';
import {
  AUDIT_CHAIN_STORE,
  SealInsertConflictError,
  keyOf,
  type AuditChainStore,
  type SealRecord,
} from '../../src/platform/audit/audit-chain-store';
import { chainHashOf, genesisPrev, hashAuditRow } from '../../src/platform/audit/audit-hash';
import { AuditSealer } from '../../src/platform/audit/audit-sealer';
import { AuditVerifier } from '../../src/platform/audit/audit-verifier';
import {
  AUDIT_VERIFY_EXIT,
  runAuditVerifyCommand,
} from '../../src/platform/audit/audit-verify-command';
import { SeedRoles } from '../../src/modules/identity/application/use-cases/seed-roles.use-case';
import { CheckedInRoleSeed } from '../../src/modules/identity/infrastructure/seed/checked-in-role-seed';
import { IdentityModule } from '../../src/modules/identity/identity.module';
import {
  AUDIT_WRITER,
  AuditWriteRefusedError,
  type AuditWriter,
} from '../../src/platform/audit/audit-writer';
import { CLOCK } from '../../src/platform/clock/clock.module';
import { PLATFORM_TENANT_ID } from '../../src/platform/market-context/tenant';
import { UNIT_OF_WORK, type UnitOfWork } from '../../src/platform/unit-of-work/unit-of-work';
import { RecordingAnchor } from '../support/in-memory-audit-chain';
import { testAppConfig, TEST_MARKETS } from '../support/test-config';
import { auditOwnerTestDatabaseUrl, auditTestDatabaseUrl } from './test-database';

// Identity slice 6b, database half of docs/design/domain/platform-audit.md 16 ("Database"): the
// sealer and the verifier on the real tables of docs/design/data/platform.md 11, through the
// application login, for both Market fixtures. The owner connection plays the attacker (and
// resets the chain between cases) with the user triggers off, in a copy of the run database
// that no other file uses (global-setup.ts, `audit`).

const START = Temporal.Instant.from('2026-10-08T06:00:00Z');
const marketOf = (code: string) => testMarketContext(code, PLATFORM_TENANT_ID);
/** The seal's foreign key to its row (DP 11.3), dropped and restored by the E1 cases. */
const SEAL_FOREIGN_KEY = 'audit_log_seal_market_id_audit_occurred_at_audit_log_id_fkey';
const CHAIN_TABLES = [
  'platform.audit_log_seal',
  'platform.audit_chain_checkpoint',
  'platform.audit_log',
];

describe('the audit chain on the database (slice 6b)', () => {
  const clock = new FixedClock(START);
  let app: INestApplicationContext;
  let unitOfWork: UnitOfWork;
  let store: AuditChainStore;
  /** The owner of the copy: the migration role. */
  let owner: Client;
  /** The application login, which may INSERT into the chain tables (DP 11.6). */
  let sql: Client;
  let errors: jest.SpyInstance;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        AppModule.register({
          config: testAppConfig({ DATABASE_URL: auditTestDatabaseUrl() }),
          logDestination: pino.destination(devNull),
        }),
      ],
    })
      .overrideProvider(CLOCK)
      .useValue(clock)
      .compile();
    app = await moduleRef.init();
    unitOfWork = app.get<UnitOfWork>(UNIT_OF_WORK);
    store = app.get<AuditChainStore>(AUDIT_CHAIN_STORE);
    owner = new Client({ connectionString: auditOwnerTestDatabaseUrl() });
    await owner.connect();
    sql = new Client({ connectionString: auditTestDatabaseUrl() });
    await sql.connect();
  });

  afterAll(async () => {
    await sql.end();
    await owner.end();
    await app.close();
  });

  beforeEach(async () => {
    clock.set(START);
    await asOwnerWithoutTriggers(async () => {
      for (const table of CHAIN_TABLES) await owner.query(`DELETE FROM ${table}`);
    });
    errors = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  /**
   * Runs `work` as the owner with the append-only triggers off, in one transaction that turns
   * them on again before it commits, so no other session ever sees them off (Mojtaba L3).
   */
  async function asOwnerWithoutTriggers(work: () => Promise<void>): Promise<void> {
    await owner.query('BEGIN');
    try {
      for (const table of CHAIN_TABLES) {
        await owner.query(`ALTER TABLE ${table} DISABLE TRIGGER USER`);
      }
      await work();
      for (const table of CHAIN_TABLES) {
        await owner.query(`ALTER TABLE ${table} ENABLE TRIGGER USER`);
      }
      await owner.query('COMMIT');
    } catch (error) {
      await owner.query('ROLLBACK');
      throw error;
    }
  }

  /** Empties the chain tables, then runs `ddl` as the owner: the restore of a dropped constraint. */
  async function resetThen(ddl: string): Promise<void> {
    await asOwnerWithoutTriggers(async () => {
      for (const table of CHAIN_TABLES) await owner.query(`DELETE FROM ${table}`);
    });
    await owner.query(ddl);
  }

  /** An audit row at `at`, inserted as the owner; `after` is raw jsonb text. */
  async function rowAt(
    market: MarketContext,
    at: Temporal.Instant,
    after = '{"n": 1}',
  ): Promise<string> {
    const id = uuidV7(at.epochMilliseconds, randomBytes(10));
    await owner.query(
      `INSERT INTO platform.audit_log
         (id, market_id, tenant_id, occurred_at, actor_type, action, target_type, target_id, after, correlation_id)
       VALUES ($1::uuid, $2, $3, $4, 'SYSTEM', 'identity.role.seeded', 'identity.role', $1::text, $5::jsonb, $6)`,
      [
        id,
        market.marketId,
        market.tenantId,
        new Date(at.epochMilliseconds),
        after,
        `chain-${randomBytes(6).toString('hex')}`,
      ],
    );
    return id;
  }

  /** `count` rows a second apart, ending 10 minutes before START. */
  async function rows(market: MarketContext, count: number): Promise<string[]> {
    const ids: string[] = [];
    for (let index = 0; index < count; index += 1) {
      ids.push(await rowAt(market, START.subtract({ minutes: 10, seconds: count - index })));
    }
    return ids;
  }

  const sealerOf = (anchor = new RecordingAnchor()) =>
    new AuditSealer(unitOfWork, store, anchor, clock);
  const verifierOf = (anchor: RecordingAnchor | null = null) =>
    new AuditVerifier(unitOfWork, store, clock, anchor);

  async function sealCount(market: MarketContext): Promise<number> {
    const { rows: found } = await owner.query<{ count: string }>(
      'SELECT count(*) FROM platform.audit_log_seal WHERE market_id = $1',
      [market.marketId],
    );
    return Number(found[0]!.count);
  }

  async function headOf(market: MarketContext): Promise<SealRecord> {
    const result = await unitOfWork.run(
      market,
      async () => ok(await store.lastSeals(market, 1, 1)),
      {
        readOnly: true,
      },
    );
    if (!result.ok) throw new Error('unreachable');
    return result.value[0]!;
  }

  const codesOf = (findings: readonly { code: string; chainSeq: bigint | null }[]) =>
    findings.map((finding) => [finding.code, finding.chainSeq]);

  describe.each(TEST_MARKETS)('for market %s', (code) => {
    const market = marketOf(code);
    const other = marketOf(code === 'AU' ? 'ZZ' : 'AU');
    const context = testCallContext(market, 'system');
    const otherContext = testCallContext(other, 'system');

    it('seals settled rows only, one chain per Market, and verifies them clean, full and incremental', async () => {
      await rows(market, 3);
      await rowAt(market, START.subtract({ minutes: 4, seconds: 59 }));
      await rows(other, 2);
      const anchor = new RecordingAnchor();

      await expect(sealerOf(anchor).run(context)).resolves.toMatchObject({
        sealed: 3,
        ended: 'idle',
      });
      expect(await sealCount(market)).toBe(3);
      expect(await sealCount(other)).toBe(0);
      expect(anchor.checkpoints.map((a) => [a.marketId, a.chainSeq])).toEqual([[code, 3n]]);

      await expect(sealerOf().run(otherContext)).resolves.toMatchObject({ sealed: 2 });
      const verifier = verifierOf(anchor);
      await expect(verifier.verify(context, 'full')).resolves.toMatchObject({
        pinnedHead: 3n,
        sealsChecked: 3,
        findings: [],
      });
      await expect(verifier.verify(context, 'incremental')).resolves.toMatchObject({
        fromSeq: 4n,
        sealsChecked: 0,
        findings: [],
      });
      await expect(verifierOf().verify(otherContext, 'full')).resolves.toMatchObject({
        findings: [],
      });
    });

    it('lets two sealers race without a fork: every row is sealed once and the chain verifies', async () => {
      await rows(market, 1200);
      const infos = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
      // Both sealers read the head before either inserts: a barrier at the first insert forces
      // the contention (Sajad L2).
      const racing = barrierStore(2);
      const outcomes = await Promise.all([
        new AuditSealer(unitOfWork, racing, new RecordingAnchor(), clock).run(context),
        new AuditSealer(unitOfWork, racing, new RecordingAnchor(), clock).run(context),
      ]);
      for (;;) {
        const run = await sealerOf().run(context);
        if (run.sealed === 0) break;
      }

      expect(outcomes.map((run) => run.ended).sort()).toEqual(['idle', 'lost-race']);
      const lost = infos.mock.calls
        .map(([line]) => line as { msg?: string; sqlState?: string })
        .filter((line) => line.msg === 'audit.seal.lost-race');
      expect(lost).toHaveLength(1);
      expect(['23505', '55P03', '40P01']).toContain(lost[0]!.sqlState);
      expect(alertsOf('audit.chain.broken')).toEqual([]);
      expect(alertsOf('audit.seal.duplicate-row')).toEqual([]);
      expect(await sealCount(market)).toBe(1200);
      await expect(verifierOf().verify(context, 'full')).resolves.toMatchObject({
        sealsChecked: 1200,
        findings: [],
      });
    });

    it('tells the two unique violations apart by the constraint name of the Prisma error (Mojtaba F5)', async () => {
      const [first, second] = await rows(market, 2);
      await sealerOf().run(context);
      const head = await headOf(market);
      expect(head.auditLogId).toBe(second);
      const insert = (seal: SealRecord) =>
        unitOfWork.run(market, async () => {
          await store.insertSeals(market, [seal]);
          return ok(undefined);
        });

      // The primary key: another sealer took the position.
      const third = await rowAt(market, START.subtract({ minutes: 9 }));
      const position = await insert({
        ...head,
        auditLogId: third,
        auditOccurredAt: START.subtract({ minutes: 9 }),
      }).catch((error: unknown) => error);
      expect(position).toBeInstanceOf(SealInsertConflictError);
      expect((position as SealInsertConflictError).conflict).toBe('position-taken');

      // The unique key: the row is already sealed in the epoch.
      const firstKey = keyOf(await rowRecord(market, first!));
      const firstSeal = (await unitOfWork.run(
        market,
        async () => ok(await store.sealsOfRows(market, 1, [firstKey])),
        {
          readOnly: true,
        },
      )) as { ok: true; value: SealRecord[] };
      const row = await insert({ ...firstSeal.value[0]!, chainSeq: 99n }).catch(
        (error: unknown) => error,
      );
      expect(row).toBeInstanceOf(SealInsertConflictError);
      expect((row as SealInsertConflictError).conflict).toBe('row-sealed');
    });

    it('stops a Market whose watermark is in the future and alerts stalled while rows wait (Hassan N1 a)', async () => {
      await rows(market, 1);
      await sealerOf().run(context);
      const head = await headOf(market);
      // The owner forges a row in the future with a correctly linked seal at head + 1.
      const futureAt = START.add({ hours: 2 });
      const forged = await rowAt(market, futureAt);
      const forgedRow = await rowRecord(market, forged);
      const rowHash = hashAuditRow(forgedRow).hash;
      const chainHash = chainHashOf({
        hashVersion: 1,
        epoch: 1,
        prev: head.chainHash,
        chainSeq: 2n,
        late: false,
        rowHash,
      });
      await insertSealAsOwner(market, {
        epoch: 1,
        chainSeq: 2n,
        id: forged,
        at: futureAt,
        rowHash,
        chainHash,
      });
      await rowAt(market, START.subtract({ minutes: 6 }));
      await rows(other, 1);

      const sealer = sealerOf();
      const runs = [];
      for (let index = 0; index < 3; index += 1) runs.push(await sealer.run(context));

      expect(runs.map((run) => run.ended)).toEqual([
        'watermark-future',
        'watermark-future',
        'watermark-future',
      ]);
      expect(await sealCount(market)).toBe(2);
      expect(alertsOf('audit.seal.watermark-future')[0]).toMatchObject({
        marketId: code,
        chainSeq: '2',
        auditLogId: forged,
      });
      expect(alertsOf('audit.seal.stalled')).toHaveLength(1);
      // The verifier reports the forged watermark, the waiting row (check (d) stops at now - S)
      // and the row in the future; the other Market seals and verifies.
      expect(codesOf((await verifierOf().verify(context, 'full')).findings)).toEqual([
        ['audit.seal.watermark-future', 2n],
        ['audit.row.unsealed', null],
        ['audit.row.future', null],
      ]);
      await expect(sealer.run(otherContext)).resolves.toMatchObject({ sealed: 1, ended: 'idle' });
      await expect(verifierOf().verify(otherContext, 'full')).resolves.toMatchObject({
        findings: [],
      });
    });

    it('reports a seal of an unknown epoch and keeps sealing epoch 1 (F12)', async () => {
      await rows(market, 2);
      await sealerOf().run(context);
      const spliced = await rowAt(market, START.subtract({ minutes: 8 }));
      const rowHash = hashAuditRow(await rowRecord(market, spliced)).hash;
      const chainHash = chainHashOf({
        hashVersion: 1,
        epoch: 2,
        prev: genesisPrev(),
        chainSeq: 1n,
        late: false,
        rowHash,
      });
      await insertSealAsOwner(market, {
        epoch: 2,
        chainSeq: 1n,
        id: spliced,
        at: START.subtract({ minutes: 8 }),
        rowHash,
        chainHash,
      });
      await rowAt(market, START.subtract({ minutes: 7 }));

      await expect(sealerOf().run(context)).resolves.toMatchObject({ ended: 'idle' });
      const head = await headOf(market);
      expect(head.epoch).toBe(1);
      const report = await verifierOf().verify(context, 'full');
      expect(codesOf(report.findings)).toEqual([['audit.seal.unknown-epoch', 1n]]);
      expect(report.findings[0]!.epoch).toBe(2);
    });

    it('seals a late row with late = true and verifies clean', async () => {
      await rows(market, 3);
      const sealer = sealerOf();
      await sealer.run(context);
      // A row committed late, below the watermark.
      await rowAt(market, START.subtract({ minutes: 10, seconds: 2, milliseconds: 500 }));
      clock.advance(Temporal.Duration.from({ minutes: 5 }));

      await expect(sealer.run(context)).resolves.toMatchObject({ sealed: 1, late: 1 });
      expect(alertsOf('audit.seal.late-row')).toHaveLength(1);
      await expect(verifierOf().verify(context, 'full')).resolves.toMatchObject({
        lateSeals: 1,
        findings: [],
      });

      // The next normal run seals new rows on top: the chain grows, no conflict (Sajad L3).
      await rowAt(market, clock.now().subtract({ minutes: 6 }));
      await rowAt(market, clock.now().subtract({ minutes: 5, seconds: 30 }));
      await expect(sealer.run(context)).resolves.toMatchObject({
        sealed: 2,
        late: 0,
        ended: 'idle',
      });
      expect((await headOf(market)).chainSeq).toBe(6n);
      expect(alertsOf('audit.seal.duplicate-row')).toEqual([]);
      await expect(verifierOf().verify(context, 'full')).resolves.toMatchObject({
        sealsChecked: 6,
        findings: [],
      });
    });

    it('seals a jsonb number beyond the double range with the fallback hash and flags it (Hassan M2)', async () => {
      await rows(market, 1);
      await rowAt(market, START.subtract({ minutes: 9 }), '{"n": 1e400}');

      await expect(sealerOf().run(context)).resolves.toMatchObject({ sealed: 2, ended: 'idle' });
      expect(alertsOf('audit.row.noncanonical')).toEqual([
        expect.objectContaining({ chainSeq: '2' }),
      ]);
      expect(codesOf((await verifierOf().verify(context, 'full')).findings)).toEqual([
        ['audit.row.noncanonical', 2n],
      ]);
    });

    describe('tampering by the owner with the triggers off', () => {
      async function sealedChain(count: number, anchor = new RecordingAnchor()) {
        const ids = await rows(market, count);
        await rows(other, 2);
        await sealerOf(anchor).run(context);
        await sealerOf().run(otherContext);
        return ids;
      }

      async function tamper(statement: string, values: unknown[]): Promise<void> {
        await asOwnerWithoutTriggers(async () => {
          await owner.query(statement, values);
        });
      }

      afterEach(async () => {
        // Tampering with one Market never shows in the other.
        await expect(verifierOf().verify(otherContext, 'full')).resolves.toMatchObject({
          findings: [],
        });
      });

      it('an edited row: audit.row.mismatch, and the command exits 2', async () => {
        const ids = await sealedChain(3);
        const lines: string[] = [];
        await expect(
          runAuditVerifyCommand(
            app,
            ['--market', code, '--full'],
            (l) => lines.push(l),
            (l) => lines.push(l),
          ),
        ).resolves.toBe(AUDIT_VERIFY_EXIT.clean);

        await tamper(`UPDATE platform.audit_log SET after = '{"n": 2}'::jsonb WHERE id = $1`, [
          ids[1],
        ]);

        expect(codesOf((await verifierOf().verify(context, 'full')).findings)).toEqual([
          ['audit.row.mismatch', 2n],
        ]);
        await expect(
          runAuditVerifyCommand(
            app,
            ['--market', code, '--full'],
            (l) => lines.push(l),
            (l) => lines.push(l),
          ),
        ).resolves.toBe(AUDIT_VERIFY_EXIT.findings);
        expect(lines.join('\n')).not.toContain('"n"');
      });

      it('a deleted row and its seal: audit.chain.gap', async () => {
        const ids = await sealedChain(4);
        await tamper('DELETE FROM platform.audit_log_seal WHERE audit_log_id = $1', [ids[1]]);
        await tamper('DELETE FROM platform.audit_log WHERE id = $1', [ids[1]]);

        expect(codesOf((await verifierOf().verify(context, 'full')).findings)).toEqual([
          ['audit.chain.gap', 2n],
        ]);
      });

      it('a cut tail: audit.anchor.mismatch from the anchor above the head', async () => {
        const anchor = new RecordingAnchor();
        const ids = await sealedChain(3, anchor);
        await tamper('DELETE FROM platform.audit_log_seal WHERE audit_log_id = $1', [ids[2]]);
        await tamper('DELETE FROM platform.audit_chain_checkpoint WHERE market_id = $1', [code]);

        // Row 3 is now above the watermark, so only the anchor tells.
        expect(codesOf((await verifierOf(anchor).verify(context, 'full')).findings)).toEqual([
          ['audit.anchor.mismatch', 3n],
        ]);
      });

      it('a changed chain_hash: audit.chain.broken at it and at the next link', async () => {
        await sealedChain(4);
        await tamper(
          `UPDATE platform.audit_log_seal SET chain_hash = $2 WHERE market_id = $1 AND epoch = 1 AND chain_seq = 2`,
          [code, Buffer.alloc(32, 7)],
        );

        expect(codesOf((await verifierOf().verify(context, 'full')).findings)).toEqual([
          ['audit.chain.broken', 2n],
          ['audit.chain.broken', 3n],
        ]);
      });

      it('a raised hash_version past a dropped CHECK: audit.seal.hash-version and a broken link (Mohammad 12)', async () => {
        await sealedChain(3);
        await owner.query(
          'ALTER TABLE platform.audit_log_seal DROP CONSTRAINT audit_log_seal_hash_version_check',
        );
        try {
          await tamper(
            'UPDATE platform.audit_log_seal SET hash_version = 2 WHERE market_id = $1 AND epoch = 1 AND chain_seq = 2',
            [code],
          );

          // Seal 3 keeps version 1, below the 2 before it: the version went down.
          expect(codesOf((await verifierOf().verify(context, 'full')).findings)).toEqual([
            ['audit.seal.hash-version', 2n],
            ['audit.chain.broken', 2n],
            ['audit.seal.hash-version', 3n],
          ]);
        } finally {
          await resetThen(
            'ALTER TABLE platform.audit_log_seal ADD CONSTRAINT audit_log_seal_hash_version_check CHECK ("hash_version" IN (1))',
          );
        }
      });

      describe('with the seal foreign key dropped (Mohammad E1)', () => {
        beforeEach(async () => {
          await owner.query(
            `ALTER TABLE platform.audit_log_seal DROP CONSTRAINT ${SEAL_FOREIGN_KEY}`,
          );
        });
        afterEach(async () => {
          await resetThen(
            `ALTER TABLE platform.audit_log_seal ADD CONSTRAINT ${SEAL_FOREIGN_KEY}
               FOREIGN KEY (market_id, audit_occurred_at, audit_log_id)
               REFERENCES platform.audit_log (market_id, occurred_at, id)
               ON DELETE RESTRICT ON UPDATE RESTRICT`,
          );
        });

        it('a sealed row deleted: audit.row.missing, and the verification completes', async () => {
          const ids = await sealedChain(3);
          await tamper('DELETE FROM platform.audit_log WHERE id = $1', [ids[1]]);

          const report = await verifierOf().verify(context, 'full');

          expect(report.complete).toBe(true);
          expect(codesOf(report.findings)).toEqual([['audit.row.missing', 2n]]);
        });

        it("a seal's audit_occurred_at changed: audit.seal.time-mismatch", async () => {
          const ids = await sealedChain(3);
          await tamper(
            `UPDATE platform.audit_log_seal SET audit_occurred_at = audit_occurred_at + interval '1 millisecond'
              WHERE audit_log_id = $1`,
            [ids[1]],
          );

          const codes = codesOf((await verifierOf().verify(context, 'full')).findings);
          expect(codes).toContainEqual(['audit.seal.time-mismatch', 2n]);
          // The anti-join of (d) follows the key, so the row also reads as unsealed.
          expect(codes).toEqual(expect.arrayContaining([['audit.row.unsealed', null]]));
        });
      });

      it('a selected row sealed by another session at a gap: audit.seal.duplicate-row through the sealer (Sajad L4)', async () => {
        const ids = await sealedChain(5);
        // A gap below the head's predecessor, so the head still links.
        await tamper('DELETE FROM platform.audit_log_seal WHERE audit_log_id = $1', [ids[1]]);
        const fresh = await rowAt(market, START.subtract({ minutes: 8 }));
        const freshAt = START.subtract({ minutes: 8 });

        // Another session seals the fresh row at the gap and commits while the sealer waits.
        await owner.query('BEGIN');
        await owner.query(
          `INSERT INTO platform.audit_log_seal
             (market_id, tenant_id, epoch, chain_seq, audit_log_id, audit_occurred_at, row_hash,
              chain_hash, late, hash_version, sealed_at)
           VALUES ($1, $2, 1, 2, $3, $4, $5, $5, false, 1, $6)`,
          [
            code,
            market.tenantId,
            fresh,
            new Date(freshAt.epochMilliseconds),
            Buffer.alloc(32, 1),
            new Date(START.epochMilliseconds),
          ],
        );
        const run = sealerOf().run(context);
        await new Promise((resolve) => setTimeout(resolve, 500));
        await owner.query('COMMIT');

        await expect(run).resolves.toMatchObject({ ended: 'duplicate-row', sealed: 0 });
        expect(alertsOf('audit.seal.duplicate-row')).toEqual([
          expect.objectContaining({ marketId: code, chainSeq: '2', auditLogId: fresh }),
        ]);
      });
    });

    describe('times out of range written by the application login (Hassan M1, Mojtaba)', () => {
      afterEach(async () => {
        await expect(verifierOf().verify(otherContext, 'full')).resolves.toMatchObject({
          findings: [],
        });
      });

      async function rowAtText(occurredAt: string): Promise<string> {
        const id = uuidV7(Date.now(), randomBytes(10));
        await sql.query(
          `INSERT INTO platform.audit_log
             (id, market_id, tenant_id, occurred_at, actor_type, action, target_type, target_id, correlation_id)
           VALUES ($1::uuid, $2, $3, $4::timestamptz, 'SYSTEM', 'identity.role.seeded', 'identity.role', $1::text, 'chain-range')`,
          [id, code, market.tenantId, occurredAt],
        );
        return id;
      }

      it('rows at infinity, -infinity and year 280000: the sealer seals the rest, the verifier names them, the command exits 2', async () => {
        const odd = [
          await rowAtText('infinity'),
          await rowAtText('-infinity'),
          await rowAtText('280000-01-01 00:00:00+00'),
          await rowAtText('1999-12-31 23:59:59.999+00'),
        ];
        await rows(market, 2);
        await rows(other, 1);
        await sealerOf().run(otherContext);

        await expect(sealerOf().run(context)).resolves.toMatchObject({ sealed: 2, ended: 'idle' });
        const report = await verifierOf().verify(context, 'full');
        expect(report.complete).toBe(true);
        expect(report.findings.map((f) => [f.code, f.auditLogId]).sort()).toEqual(
          odd.map((id) => ['audit.row.out-of-range', id]).sort(),
        );
        const lines: string[] = [];
        await expect(
          runAuditVerifyCommand(
            app,
            ['--market', code, '--full'],
            (l) => lines.push(l),
            (l) => lines.push(l),
          ),
        ).resolves.toBe(AUDIT_VERIFY_EXIT.findings);
      });

      it('a seal with sealed_at = infinity: no crash, audit.seal.out-of-range by position', async () => {
        await rows(market, 2);
        await rows(other, 1);
        await sealerOf().run(context);
        await sealerOf().run(otherContext);
        const head = await headOf(market);
        const third = await rowAt(market, START.subtract({ minutes: 9 }));
        const rowHash = hashAuditRow(await rowRecord(market, third)).hash;
        const chainHash = chainHashOf({
          hashVersion: 1,
          epoch: 1,
          prev: head.chainHash,
          chainSeq: 3n,
          late: false,
          rowHash,
        });
        await sql.query(
          `INSERT INTO platform.audit_log_seal
             (market_id, tenant_id, epoch, chain_seq, audit_log_id, audit_occurred_at, row_hash,
              chain_hash, late, hash_version, sealed_at)
           VALUES ($1, $2, 1, 3, $3, $4, $5, $6, false, 1, 'infinity')`,
          [
            code,
            market.tenantId,
            third,
            new Date(START.subtract({ minutes: 9 }).epochMilliseconds),
            Buffer.from(rowHash),
            Buffer.from(chainHash),
          ],
        );

        const run = await sealerOf().run(context);
        expect(['lost-race', 'duplicate-row']).toContain(run.ended);
        const report = await verifierOf().verify(context, 'full');
        expect(report.complete).toBe(true);
        expect(codesOf(report.findings)).toEqual([['audit.seal.out-of-range', 3n]]);
        // The incremental read has no upper bound at the pinned head (Mojtaba D1).
        const incremental = await verifierOf().verify(context, 'incremental');
        expect(codesOf(incremental.findings)).toEqual([['audit.seal.out-of-range', 3n]]);
      });

      it('a seal in an unknown epoch with sealed_at = infinity: an incremental run names it (Mojtaba D1)', async () => {
        await rows(market, 2);
        await rows(other, 1);
        await sealerOf().run(context);
        await sealerOf().run(otherContext);
        const head = await headOf(market);
        await sql.query(
          `INSERT INTO platform.audit_log_seal
             (market_id, tenant_id, epoch, chain_seq, audit_log_id, audit_occurred_at, row_hash,
              chain_hash, late, hash_version, sealed_at)
           SELECT market_id, tenant_id, 2, 1, audit_log_id, audit_occurred_at, row_hash,
                  chain_hash, late, hash_version, 'infinity'
             FROM platform.audit_log_seal
            WHERE market_id = $1 AND epoch = 1 AND chain_seq = $2`,
          [code, head.chainSeq],
        );

        const report = await verifierOf().verify(context, 'incremental');
        expect(report.complete).toBe(true);
        expect(report.findings.map(({ code: c, epoch, chainSeq }) => [c, epoch, chainSeq])).toEqual(
          [['audit.seal.out-of-range', 2, 1n]],
        );
      });

      it('a checkpoint with created_at = infinity: the sealer goes on, audit.checkpoint.out-of-range', async () => {
        await rows(market, 2);
        await rows(other, 1);
        await sealerOf().run(otherContext);
        await sql.query(
          `INSERT INTO platform.audit_chain_checkpoint
             (market_id, tenant_id, epoch, chain_seq, chain_hash, hash_version, created_at)
           VALUES ($1, $2, 1, 50, $3, 1, 'infinity')`,
          [code, market.tenantId, Buffer.alloc(32, 3)],
        );

        await expect(sealerOf().run(context)).resolves.toMatchObject({ sealed: 2, ended: 'idle' });
        const report = await verifierOf().verify(context, 'full');
        expect(codesOf(report.findings)).toEqual([['audit.checkpoint.out-of-range', 50n]]);
      });

      it('a checkpoint at the position the batch reaches: audit.checkpoint.conflict, the batch rolls back (Mojtaba L2)', async () => {
        await rows(market, 2);
        await rows(other, 1);
        await sealerOf().run(otherContext);
        await sql.query(
          `INSERT INTO platform.audit_chain_checkpoint
             (market_id, tenant_id, epoch, chain_seq, chain_hash, hash_version, created_at)
           VALUES ($1, $2, 1, 2, $3, 1, $4)`,
          [
            code,
            market.tenantId,
            Buffer.alloc(32, 3),
            new Date(START.subtract({ hours: 2 }).epochMilliseconds),
          ],
        );

        await expect(sealerOf().run(context)).resolves.toMatchObject({
          ended: 'checkpoint-conflict',
          sealed: 0,
        });
        expect(alertsOf('audit.checkpoint.conflict')).toEqual([
          expect.objectContaining({ marketId: code }),
        ]);
        expect(await sealCount(market)).toBe(0);
      });
    });
  });

  // Identity's seed on the one copy where no Market has its roles yet (Sajad L5): a refused
  // audit row rolls the role back with it. The only test of this file that seeds roles.
  it('a refused identity.role.seeded rolls the role back; the next run creates it with its row', async () => {
    for (const code of TEST_MARKETS) {
      const market = marketOf(code);
      const system = testCallContext(market, 'system', `seed-refused-${code.toLowerCase()}`);
      const countRoles = async () =>
        Number(
          (
            await owner.query<{ count: string }>(
              `SELECT count(*) FROM identity.roles WHERE market_id = $1 AND kind = 'system'`,
              [code],
            )
          ).rows[0]!.count,
        );
      expect(await countRoles()).toBe(0);
      const writer = app.select(IdentityModule).get<AuditWriter>(AUDIT_WRITER, { strict: true });
      const refusing = jest
        .spyOn(writer, 'record')
        .mockRejectedValue(new AuditWriteRefusedError('entry-invalid', 'after'));

      await app
        .get(SeedRoles)
        .execute(system, {})
        .catch((error: unknown) => error);

      expect(await countRoles()).toBe(0);
      refusing.mockRestore();
      await app.get(SeedRoles).execute(system, {});
      // One system role per scope: platform, merchant and courier.
      expect(await countRoles()).toBe(3);
      const { rows: seeded } = await owner.query(
        `SELECT 1 FROM platform.audit_log WHERE market_id = $1 AND action = 'identity.role.seeded'`,
        [code],
      );
      expect(seeded).toHaveLength(new CheckedInRoleSeed().roles().length);
    }
  });

  /**
   * The real store with a barrier at the first insert of seals: no insert proceeds until
   * `parties` sealers have reached one, so they all read the same head first.
   */
  function barrierStore(parties: number): AuditChainStore {
    let arrived = 0;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    return new Proxy(store, {
      get(target, property, receiver) {
        if (property === 'insertSeals') {
          return async (market: MarketContext, seals: readonly SealRecord[]) => {
            arrived += 1;
            if (arrived >= parties) release();
            await gate;
            return target.insertSeals(market, seals);
          };
        }
        const value: unknown = Reflect.get(target, property, receiver);
        return typeof value === 'function'
          ? (value as (...args: unknown[]) => unknown).bind(target)
          : value;
      },
    });
  }

  /** An audit row read back through the store's mapping, as the sealer hashes it. */
  async function rowRecord(market: MarketContext, id: string) {
    const result = await unitOfWork.run(
      market,
      async () =>
        ok(await store.rowsAfter(market, Temporal.Instant.from('2000-01-01T00:00:00Z'), 10_000)),
      { readOnly: true },
    );
    if (!result.ok) throw new Error('unreachable');
    return result.value.find((row) => row.id === id)!;
  }

  async function insertSealAsOwner(
    market: MarketContext,
    seal: {
      epoch: number;
      chainSeq: bigint;
      id: string;
      at: Temporal.Instant;
      rowHash: Uint8Array;
      chainHash: Uint8Array;
    },
  ): Promise<void> {
    await owner.query(
      `INSERT INTO platform.audit_log_seal
         (market_id, tenant_id, epoch, chain_seq, audit_log_id, audit_occurred_at, row_hash,
          chain_hash, late, hash_version, sealed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, false, 1, $9)`,
      [
        market.marketId,
        market.tenantId,
        seal.epoch,
        String(seal.chainSeq),
        seal.id,
        new Date(seal.at.epochMilliseconds),
        Buffer.from(seal.rowHash),
        Buffer.from(seal.chainHash),
        new Date(START.epochMilliseconds),
      ],
    );
  }

  function alertsOf(code: string) {
    return errors.mock.calls
      .map(
        ([line]) =>
          line as {
            msg: string;
            marketId: string;
            chainSeq: string | null;
            auditLogId: string | null;
          },
      )
      .filter((line) => line.msg === code);
  }
});
