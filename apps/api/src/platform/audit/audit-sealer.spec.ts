import { Logger } from '@nestjs/common';
import { Temporal } from '@mondapac-drive/shared-kernel';
import type { MarketContext } from '@mondapac-drive/shared-kernel';
import {
  FixedClock,
  testCallContext,
  testMarketContext,
} from '@mondapac-drive/shared-kernel/testing';
import {
  FakeUnitOfWork,
  InMemoryAuditChainStore,
  RecordingAnchor,
} from '../../../test/support/in-memory-audit-chain';
import { TEST_MARKETS } from '../../../test/support/test-config';
import { PLATFORM_TENANT_ID } from '../market-context/tenant';
import { TransactionConflictError } from '../unit-of-work/errors';
import { SEAL_BATCH_SIZE } from './audit-chain-policy';
import { SealInsertConflictError, type SealRecord } from './audit-chain-store';
import {
  chainHashOf,
  genesisPrev,
  hashAuditRow,
  sameHash,
  type AuditRowRecord,
} from './audit-hash';
import { AuditSealer } from './audit-sealer';

// The sealer's unit tests of docs/design/domain/platform-audit.md 16 ("Unit"): settle and
// watermark logic, checkpoints and the heartbeat, the late scan's cadence, the stall and
// watermark-in-the-future stops (Hassan N1 a), the fallback hash (M2), and the conflict
// classes (7.1 "Duplicates", 7.2), on in-memory chains, for both Market fixtures.

const START = Temporal.Instant.from('2026-10-08T06:00:00Z');
const marketOf = (code: string) => testMarketContext(code, PLATFORM_TENANT_ID);

let sequence = 0;
/** A row of `market` at `at`; ids rise with each call, so (occurred_at, id) order is call order. */
function rowAt(
  market: MarketContext,
  at: Temporal.Instant,
  after: unknown = { n: 1 },
): AuditRowRecord {
  sequence += 1;
  return {
    id: `01990000-0000-7000-8000-${String(sequence).padStart(12, '0')}`,
    marketId: market.marketId,
    tenantId: market.tenantId,
    occurredAt: at,
    actorType: 'SYSTEM',
    actorId: null,
    actingAsId: null,
    action: 'identity.role.seeded',
    targetType: 'identity.role',
    targetId: '01990000-0000-7000-8000-0000000000cc',
    before: null,
    after,
    correlationId: `job-${sequence}`,
  };
}

function setUp() {
  const clock = new FixedClock(START);
  const store = new InMemoryAuditChainStore();
  const units = new FakeUnitOfWork();
  const anchor = new RecordingAnchor();
  const sealer = new AuditSealer(units, store, anchor, clock);
  return { clock, store, units, anchor, sealer };
}

/** Every alert line of a code, as the sealer logged it. */
const alertsOf = (spy: jest.SpyInstance, code: string) =>
  spy.mock.calls
    .map(
      ([line]) =>
        line as {
          msg: string;
          alert?: boolean;
          marketId: string;
          chainSeq: string | null;
          auditLogId: string | null;
        },
    )
    .filter((line) => line.msg === code);

/** The seals of a Market, by chain_seq. */
function sealsOf(store: InMemoryAuditChainStore, market: MarketContext): SealRecord[] {
  const ids = new Set(store.rows.filter((r) => r.marketId === market.marketId).map((r) => r.id));
  return store.seals
    .filter((s) => ids.has(s.auditLogId))
    .sort((a, b) => (a.chainSeq < b.chainSeq ? -1 : 1));
}

/** Recomputes a Market's chain from the genesis: every link holds. */
function chainHolds(store: InMemoryAuditChainStore, market: MarketContext): boolean {
  let prev = genesisPrev();
  let expected = 1n;
  for (const seal of sealsOf(store, market)) {
    if (seal.chainSeq !== expected) return false;
    const row = store.rows.find((r) => r.id === seal.auditLogId)!;
    const link = chainHashOf({
      hashVersion: seal.hashVersion,
      epoch: seal.epoch,
      prev,
      chainSeq: seal.chainSeq,
      late: seal.late,
      rowHash: hashAuditRow(row).hash,
    });
    if (!sameHash(link, seal.chainHash)) return false;
    prev = seal.chainHash;
    expected += 1n;
  }
  return true;
}

describe.each(TEST_MARKETS)('AuditSealer (PA 7) for market %s', (code) => {
  const market = marketOf(code);
  const other = marketOf(code === 'AU' ? 'ZZ' : 'AU');
  const context = testCallContext(market, 'system');
  let errors: jest.SpyInstance;
  let infos: jest.SpyInstance;

  beforeEach(() => {
    errors = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    infos = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('seals only settled rows, in (occurred_at, id) order, from the genesis, in read-write units', async () => {
    const s = setUp();
    const settled = [
      rowAt(market, START.subtract({ minutes: 9 })),
      rowAt(market, START.subtract({ minutes: 7 })),
      rowAt(market, START.subtract({ minutes: 5 })),
    ];
    const fresh = rowAt(market, START.subtract({ minutes: 4, seconds: 59 }));
    for (const row of [fresh, ...settled.reverse()]) s.store.addRow(row);

    const run = await s.sealer.run(context);

    expect(run).toMatchObject({ sealed: 3, late: 0, ended: 'idle' });
    expect(
      sealsOf(s.store, market).map((seal) => [seal.chainSeq, seal.auditLogId, seal.late]),
    ).toEqual(settled.reverse().map((row, index) => [BigInt(index + 1), row.id, false]));
    expect(
      sealsOf(s.store, market).every((seal) => seal.epoch === 1 && seal.hashVersion === 1),
    ).toBe(true);
    expect(chainHolds(s.store, market)).toBe(true);
    expect(s.units.units.every((unit) => unit === 'read-write')).toBe(true);

    // Once settled, the fresh row is sealed by the next run.
    s.clock.advance(Temporal.Duration.from({ seconds: 1 }));
    await expect(s.sealer.run(context)).resolves.toMatchObject({ sealed: 1 });
    expect(sealsOf(s.store, market).at(-1)!.auditLogId).toBe(fresh.id);
    expect(chainHolds(s.store, market)).toBe(true);
  });

  it('keeps the chains of two Markets apart, each from chain_seq 1', async () => {
    const s = setUp();
    s.store.addRow(rowAt(market, START.subtract({ minutes: 10 })));
    s.store.addRow(rowAt(other, START.subtract({ minutes: 10 })));
    s.store.addRow(rowAt(other, START.subtract({ minutes: 9 })));

    await s.sealer.run(context);
    await s.sealer.run(testCallContext(other, 'system'));

    expect(sealsOf(s.store, market).map((seal) => seal.chainSeq)).toEqual([1n]);
    expect(sealsOf(s.store, other).map((seal) => seal.chainSeq)).toEqual([1n, 2n]);
    expect(chainHolds(s.store, market) && chainHolds(s.store, other)).toBe(true);
  });

  it('seals in batches of 500, one unit each, until no settled row is left', async () => {
    const s = setUp();
    for (let index = 0; index < SEAL_BATCH_SIZE + 20; index += 1) {
      s.store.addRow(rowAt(market, START.subtract({ minutes: 30 }).add({ milliseconds: index })));
    }

    await expect(s.sealer.run(context)).resolves.toMatchObject({ sealed: SEAL_BATCH_SIZE + 20 });
    expect(s.units.units).toEqual(['read-write', 'read-write']);
    expect(chainHolds(s.store, market)).toBe(true);
  });

  describe('the watermark (step 2; Hassan M1, Mojtaba F1)', () => {
    it('is the greatest sealed key, never the head: after a late seal no row is selected twice', async () => {
      const s = setUp();
      s.store.addRow(rowAt(market, START.subtract({ minutes: 20 })));
      s.store.addRow(rowAt(market, START.subtract({ minutes: 10 })));
      await s.sealer.run(context);
      // A backdated row: below the watermark, found by the scan of a later run.
      const backdated = rowAt(market, START.subtract({ minutes: 15 }));
      s.store.addRow(backdated);
      s.clock.advance(Temporal.Duration.from({ minutes: 5 }));

      await expect(s.sealer.run(context)).resolves.toMatchObject({ sealed: 1, late: 1 });
      const head = sealsOf(s.store, market).at(-1)!;
      expect(head).toMatchObject({ chainSeq: 3n, auditLogId: backdated.id, late: true });

      // The head now holds an older key; new rows above the true watermark still seal, once.
      const next = rowAt(market, START.subtract({ minutes: 1 }));
      s.store.addRow(next);
      await expect(s.sealer.run(context)).resolves.toMatchObject({ sealed: 1, ended: 'idle' });
      expect(sealsOf(s.store, market).map((seal) => seal.auditLogId)).toHaveLength(4);
      expect(new Set(sealsOf(s.store, market).map((seal) => seal.auditLogId)).size).toBe(4);
      expect(chainHolds(s.store, market)).toBe(true);
      expect(alertsOf(errors, 'audit.seal.late-row')).toEqual([
        expect.objectContaining({
          alert: true,
          marketId: code,
          chainSeq: '3',
          auditLogId: backdated.id,
        }),
      ]);
    });

    it('stops the Market and seals nothing when the watermark is later than now - S (Hassan N1 a)', async () => {
      const s = setUp();
      s.store.addRow(rowAt(market, START.subtract({ minutes: 10 })));
      await s.sealer.run(context);
      // A forged row in the future with a correct seal at head + 1.
      const forged = rowAt(market, START.add({ hours: 1 }));
      s.store.addRow(forged);
      const [head] = sealsOf(s.store, market);
      const rowHash = hashAuditRow(forged).hash;
      s.store.seals.push({
        epoch: 1,
        chainSeq: 2n,
        auditLogId: forged.id,
        auditOccurredAt: forged.occurredAt,
        rowHash,
        chainHash: chainHashOf({
          hashVersion: 1,
          epoch: 1,
          prev: head!.chainHash,
          chainSeq: 2n,
          late: false,
          rowHash,
        }),
        late: false,
        hashVersion: 1,
        sealedAt: START,
      });
      const waiting = rowAt(market, START.subtract({ minutes: 6 }));
      s.store.addRow(waiting);

      const runs = [];
      for (let index = 0; index < 3; index += 1) runs.push(await s.sealer.run(context));

      expect(runs.map((run) => [run.ended, run.sealed, run.pending])).toEqual([
        ['watermark-future', 0, true],
        ['watermark-future', 0, true],
        ['watermark-future', 0, true],
      ]);
      expect(sealsOf(s.store, market)).toHaveLength(2);
      expect(alertsOf(errors, 'audit.seal.watermark-future')[0]).toMatchObject({
        alert: true,
        marketId: code,
        chainSeq: '2',
        auditLogId: forged.id,
      });
      expect(alertsOf(errors, 'audit.seal.stalled')).toHaveLength(1);
      expect(s.anchor.heartbeats.filter((a) => a.marketId === code).length).toBeLessThanOrEqual(1);

      // The other Market is not affected.
      s.store.addRow(rowAt(other, START.subtract({ minutes: 10 })));
      await expect(s.sealer.run(testCallContext(other, 'system'))).resolves.toMatchObject({
        sealed: 1,
        ended: 'idle',
      });
    });
  });

  it('stops the Market at a broken head link and never repairs it (step 1)', async () => {
    const s = setUp();
    s.store.addRow(rowAt(market, START.subtract({ minutes: 20 })));
    s.store.addRow(rowAt(market, START.subtract({ minutes: 19 })));
    await s.sealer.run(context);
    s.store.replaceSeal(1, 2n, { chainHash: new Uint8Array(32).fill(7) }, code);
    s.store.addRow(rowAt(market, START.subtract({ minutes: 10 })));

    await expect(s.sealer.run(context)).resolves.toMatchObject({
      ended: 'chain-broken',
      sealed: 0,
      pending: true,
    });
    expect(sealsOf(s.store, market)).toHaveLength(2);
    expect(alertsOf(errors, 'audit.chain.broken')).toEqual([
      expect.objectContaining({ alert: true, marketId: code, chainSeq: '2' }),
    ]);
  });

  describe('checkpoints and the heartbeat (steps 5 and 6; Mojtaba F2)', () => {
    it('writes the first checkpoint at the first head, then only when the head moved and 1 h passed', async () => {
      const s = setUp();
      s.store.addRow(rowAt(market, START.subtract({ minutes: 10 })));
      await s.sealer.run(context);
      expect(s.store.checkpoints.map((c) => c.chainSeq)).toEqual([1n]);
      expect(s.anchor.checkpoints.map((a) => [a.marketId, a.chainSeq])).toEqual([[code, 1n]]);
      expect(s.anchor.checkpoints[0]!.chainHash).toMatch(/^sha256:[0-9a-f]{64}$/);

      // The head moves within the hour: no checkpoint.
      s.store.addRow(rowAt(market, START.subtract({ minutes: 9 })));
      s.clock.advance(Temporal.Duration.from({ minutes: 30 }));
      await s.sealer.run(context);
      expect(s.store.checkpoints).toHaveLength(1);

      // An hour later with no new row: the head did not move, so still no checkpoint.
      s.clock.advance(Temporal.Duration.from({ minutes: 31 }));
      await s.sealer.run(context);
      expect(s.store.checkpoints).toHaveLength(1);

      // The head moves after the hour: a checkpoint at the new head.
      s.store.addRow(rowAt(market, s.clock.now().subtract({ minutes: 6 })));
      await s.sealer.run(context);
      expect(s.store.checkpoints.map((c) => c.chainSeq)).toEqual([1n, 3n]);
      expect(
        sameHash(s.store.checkpoints[1]!.chainHash, sealsOf(s.store, market)[2]!.chainHash),
      ).toBe(true);
    });

    it('checkpoints after 10 000 seals within the hour', async () => {
      const s = setUp();
      for (let index = 0; index < 10_501; index += 1) {
        s.store.addRow(rowAt(market, START.subtract({ minutes: 50 }).add({ milliseconds: index })));
      }

      await s.sealer.run(context);

      // The first batch writes the first checkpoint (none existed); the next is due when 10 000
      // seals passed since it, at the end of the batch that reaches 10 500; the last batch of one
      // row (10 501) is within the hour and below 10 000 more, so it writes none.
      expect(s.store.checkpoints.map((c) => c.chainSeq)).toEqual([500n, 10_500n]);
    });

    it('sends a heartbeat of the head once a day, with no checkpoint row', async () => {
      const s = setUp();
      s.store.addRow(rowAt(market, START.subtract({ minutes: 10 })));
      await s.sealer.run(context);
      expect(s.anchor.heartbeats.map((a) => a.chainSeq)).toEqual([1n]);

      s.clock.advance(Temporal.Duration.from({ hours: 23 }));
      await s.sealer.run(context);
      expect(s.anchor.heartbeats).toHaveLength(1);

      s.clock.advance(Temporal.Duration.from({ hours: 1 }));
      await s.sealer.run(context);
      expect(s.anchor.heartbeats.map((a) => a.chainSeq)).toEqual([1n, 1n]);
      expect(s.store.checkpoints).toHaveLength(1);
    });

    it('alerts audit.anchor.failed and goes on sealing when the anchor cannot be reached', async () => {
      const s = setUp();
      s.anchor.down = true;
      s.store.addRow(rowAt(market, START.subtract({ minutes: 10 })));

      await expect(s.sealer.run(context)).resolves.toMatchObject({ sealed: 1 });
      expect(alertsOf(errors, 'audit.anchor.failed').length).toBeGreaterThanOrEqual(1);
      expect(s.store.checkpoints).toHaveLength(1);
    });
  });

  describe('the late-row scan (step 4; Mojtaba F3, Ali)', () => {
    it('runs on the first run, then at most every 5 minutes', async () => {
      const s = setUp();
      s.store.addRow(rowAt(market, START.subtract({ minutes: 20 })));
      await s.sealer.run(context); // first run: scans (nothing below the watermark yet)
      s.store.addRow(rowAt(market, START.subtract({ minutes: 30 })));

      s.clock.advance(Temporal.Duration.from({ minutes: 4, seconds: 59 }));
      await expect(s.sealer.run(context)).resolves.toMatchObject({ late: 0 });

      s.clock.advance(Temporal.Duration.from({ seconds: 1 }));
      await expect(s.sealer.run(context)).resolves.toMatchObject({ late: 1 });
    });

    it('scans on the first run after the worker starts, however recently another process scanned', async () => {
      const s = setUp();
      s.store.addRow(rowAt(market, START.subtract({ minutes: 20 })));
      await s.sealer.run(context);
      s.store.addRow(rowAt(market, START.subtract({ minutes: 30 })));
      // A new process: a new sealer on the same tables.
      const restarted = new AuditSealer(s.units, s.store, s.anchor, s.clock);

      await expect(restarted.run(context)).resolves.toMatchObject({ late: 1 });
    });

    it('looks back 24 hours from the watermark only', async () => {
      const s = setUp();
      s.store.addRow(rowAt(market, START.subtract({ minutes: 20 })));
      await s.sealer.run(context);
      s.store.addRow(rowAt(market, START.subtract({ hours: 25 })));
      s.clock.advance(Temporal.Duration.from({ minutes: 5 }));

      await expect(s.sealer.run(context)).resolves.toMatchObject({ late: 0, sealed: 0 });
    });
  });

  it('seals a row canonicalJson refuses with the fallback hash, flags it, and seals the rows after it (M2)', async () => {
    const s = setUp();
    const odd = rowAt(market, START.subtract({ minutes: 10 }), { n: Number.POSITIVE_INFINITY });
    const after = rowAt(market, START.subtract({ minutes: 9 }));
    s.store.addRow(odd);
    s.store.addRow(after);

    await expect(s.sealer.run(context)).resolves.toMatchObject({ sealed: 2 });
    expect(chainHolds(s.store, market)).toBe(true);
    expect(alertsOf(errors, 'audit.row.noncanonical')).toEqual([
      expect.objectContaining({ alert: true, marketId: code, chainSeq: '1', auditLogId: odd.id }),
    ]);
  });

  it('alerts audit.seal.lagging when the oldest settled unsealed row is older than 15 minutes', async () => {
    const s = setUp();
    const old = rowAt(market, START.subtract({ minutes: 16 }));
    s.store.addRow(old);

    await s.sealer.run(context);

    expect(alertsOf(errors, 'audit.seal.lagging')).toEqual([
      expect.objectContaining({ marketId: code, auditLogId: old.id }),
    ]);
    s.store.addRow(rowAt(market, START.subtract({ minutes: 14 })));
    await s.sealer.run(context);
    expect(alertsOf(errors, 'audit.seal.lagging')).toHaveLength(1);
  });

  describe('conflicts (7.1 "Duplicates", 7.2; Mojtaba F5)', () => {
    it.each([
      ['23505 on the primary key', () => new SealInsertConflictError('position-taken')],
      ['55P03', () => new TransactionConflictError('55P03')],
      ['40P01', () => new TransactionConflictError('40P01')],
    ])('ends a lost race (%s) at info level, never audit.chain.broken', async (_case, error) => {
      const s = setUp();
      s.store.addRow(rowAt(market, START.subtract({ minutes: 10 })));
      s.store.failNextInsert = error();

      await expect(s.sealer.run(context)).resolves.toMatchObject({ ended: 'lost-race', sealed: 0 });
      // The line names the SQLSTATE that lost (Sajad L2).
      expect(infos).toHaveBeenCalledWith(
        expect.objectContaining({
          msg: 'audit.seal.lost-race',
          marketId: code,
          sqlState: _case.startsWith('23505') ? '23505' : _case,
        }),
      );
      expect(alertsOf(errors, 'audit.chain.broken')).toEqual([]);
      // The next tick continues from the head.
      await expect(s.sealer.run(context)).resolves.toMatchObject({ sealed: 1 });
    });

    it('treats a re-selected row as a lost race when the head moved meanwhile', async () => {
      const s = setUp();
      const row = rowAt(market, START.subtract({ minutes: 10 }));
      s.store.addRow(row);
      s.store.beforeInsert = (_market, seals) => {
        s.store.beforeInsert = null;
        // Another sealer committed the same row first, so the head moved, and this insert hits
        // the unique key of (occurred_at, id).
        s.store.seals.push(seals[0]!);
        s.store.failNextInsert = new SealInsertConflictError('row-sealed');
      };

      await expect(s.sealer.run(context)).resolves.toMatchObject({ ended: 'lost-race' });
      expect(alertsOf(errors, 'audit.seal.duplicate-row')).toEqual([]);
      expect(sealsOf(s.store, market)).toHaveLength(1);
    });

    it('alerts audit.seal.duplicate-row when a selected row is sealed and the head did not move; three such runs stall', async () => {
      const s = setUp();
      const row = rowAt(market, START.subtract({ minutes: 10 }));
      s.store.addRow(row);
      let attempts = 0;
      s.store.beforeInsert = () => {
        attempts += 1;
        throw new SealInsertConflictError('row-sealed');
      };

      const runs = [];
      for (let index = 0; index < 3; index += 1) runs.push(await s.sealer.run(context));

      expect(attempts).toBe(3);
      expect(runs.map((run) => [run.ended, run.stalledRuns])).toEqual([
        ['duplicate-row', 1],
        ['duplicate-row', 2],
        ['duplicate-row', 3],
      ]);
      expect(alertsOf(errors, 'audit.seal.duplicate-row')).toHaveLength(3);
      expect(alertsOf(errors, 'audit.seal.stalled')).toEqual([
        expect.objectContaining({ alert: true, marketId: code }),
      ]);
    });

    it('rethrows any other error, sealing nothing', async () => {
      const s = setUp();
      s.store.addRow(rowAt(market, START.subtract({ minutes: 10 })));
      s.store.failNextInsert = new Error('database gone');

      await expect(s.sealer.run(context)).rejects.toThrow('database gone');
      expect(sealsOf(s.store, market)).toEqual([]);
    });
  });

  describe('stalled (step 8; Hassan M1, N1 a)', () => {
    it('does not count runs with nothing waiting, nor runs that moved the head', async () => {
      const s = setUp();
      for (let index = 0; index < 4; index += 1) {
        await expect(s.sealer.run(context)).resolves.toMatchObject({ stalledRuns: 0 });
      }
      for (let index = 0; index < 4; index += 1) {
        s.store.addRow(rowAt(market, s.clock.now().subtract({ minutes: 6 })));
        await expect(s.sealer.run(context)).resolves.toMatchObject({ sealed: 1, stalledRuns: 0 });
        s.clock.advance(Temporal.Duration.from({ seconds: 10 }));
      }
      expect(alertsOf(errors, 'audit.seal.stalled')).toEqual([]);
    });

    it('fires when rows wait below the watermark of a stopped Market', async () => {
      const s = setUp();
      s.store.addRow(rowAt(market, START.subtract({ minutes: 20 })));
      s.store.addRow(rowAt(market, START.subtract({ minutes: 19 })));
      await s.sealer.run(context);
      s.store.replaceSeal(1, 2n, { late: true }, code);
      s.store.addRow(rowAt(market, START.subtract({ minutes: 25 })));

      const runs = [];
      for (let index = 0; index < 3; index += 1) runs.push(await s.sealer.run(context));

      expect(runs.map((run) => run.ended)).toEqual([
        'chain-broken',
        'chain-broken',
        'chain-broken',
      ]);
      expect(alertsOf(errors, 'audit.seal.stalled')).toHaveLength(1);
    });
  });

  describe('a run that throws (Hassan M2)', () => {
    it('alerts audit.seal.failed with the Market and epoch only, and three such runs stall', async () => {
      const s = setUp();
      s.store.addRow(rowAt(market, START.subtract({ minutes: 10 })));
      s.store.failReads = new Error('connection terminated: password=hunter2');

      for (let index = 0; index < 3; index += 1) {
        await expect(s.sealer.run(context)).rejects.toThrow('connection terminated');
      }

      const failed = alertsOf(errors, 'audit.seal.failed');
      expect(failed).toHaveLength(3);
      expect(failed[0]).toEqual({
        msg: 'audit.seal.failed',
        alert: true,
        marketId: code,
        epoch: 1,
        chainSeq: null,
        auditLogId: null,
      });
      expect(alertsOf(errors, 'audit.seal.stalled')).toHaveLength(1);
      expect(JSON.stringify(errors.mock.calls)).not.toContain('hunter2');

      // The database comes back: the run seals and the count resets.
      s.store.failReads = null;
      await expect(s.sealer.run(context)).resolves.toMatchObject({ sealed: 1, stalledRuns: 0 });
    });
  });

  describe('a checkpoint position already taken (Mojtaba L2)', () => {
    it('alerts audit.checkpoint.conflict, rolls the batch back and stalls on repeat', async () => {
      const s = setUp();
      s.store.addRow(rowAt(market, START.subtract({ minutes: 10 })));
      s.store.addRow(rowAt(market, START.subtract({ minutes: 9 })));
      // The in-memory store has no transaction: the test removes what a rollback would.
      s.store.beforeInsert = (_market, seals) => {
        queueMicrotask(() => {
          s.store.seals = s.store.seals.filter((seal) => !seals.includes(seal));
        });
      };
      // A checkpoint no sealer wrote, at the head the batch reaches, old enough that one is due.
      s.store.checkpoints.push({
        epoch: 1,
        chainSeq: 2n,
        chainHash: new Uint8Array(32).fill(6),
        hashVersion: 1,
        createdAt: START.subtract({ hours: 2 }),
        marketId: code,
      } as never);

      const runs = [];
      for (let index = 0; index < 3; index += 1) runs.push(await s.sealer.run(context));

      expect(runs.map((run) => run.ended)).toEqual([
        'checkpoint-conflict',
        'checkpoint-conflict',
        'checkpoint-conflict',
      ]);
      expect(alertsOf(errors, 'audit.checkpoint.conflict')[0]).toMatchObject({
        alert: true,
        marketId: code,
        epoch: 1,
      });
      expect(alertsOf(errors, 'audit.seal.stalled')).toHaveLength(1);
    });
  });
});
