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
import type { SealRecord } from './audit-chain-store';
import {
  chainHashOf,
  chainHashText,
  genesisPrev,
  hashAuditRow,
  type AuditRowRecord,
} from './audit-hash';
import { AuditSealer } from './audit-sealer';
import { AuditVerifier, type VerifyReport } from './audit-verifier';

// The verifier's unit tests of docs/design/domain/platform-audit.md 16 ("Unit", "Verifier"):
// checks (a) to (k) of PA 8 on in-memory chains, for both Market fixtures. Each tamper case
// changes one thing and expects exactly its finding codes; the database cases are in
// test/db/platform-audit-chain.db-spec.ts.

const START = Temporal.Instant.from('2026-10-08T06:00:00Z');
const marketOf = (code: string) => testMarketContext(code, PLATFORM_TENANT_ID);

let sequence = 0;
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

/** A sealed chain of `count` rows a minute apart, sealed by the real sealer in one run. */
async function sealedChain(count: number, markets: readonly MarketContext[]) {
  const clock = new FixedClock(START);
  const store = new InMemoryAuditChainStore();
  const units = new FakeUnitOfWork();
  const anchor = new RecordingAnchor();
  const sealer = new AuditSealer(units, store, anchor, clock);
  const rows = new Map<string, AuditRowRecord[]>();
  for (const market of markets) {
    const own: AuditRowRecord[] = [];
    for (let index = 0; index < count; index += 1) {
      const row = rowAt(market, START.subtract({ minutes: 60 - index }));
      own.push(row);
      store.addRow(row);
    }
    rows.set(market.marketId, own);
    await sealer.run(testCallContext(market, 'system'));
  }
  const verifier = new AuditVerifier(units, store, clock, anchor);
  return { clock, store, units, anchor, sealer, verifier, rows };
}

/** The seals of a Market, by chain_seq. */
function sealsOf(store: InMemoryAuditChainStore, market: MarketContext): SealRecord[] {
  const ids = new Set(store.rows.filter((r) => r.marketId === market.marketId).map((r) => r.id));
  return store.seals
    .filter((s) => ids.has(s.auditLogId))
    .sort((a, b) => (a.chainSeq < b.chainSeq ? -1 : 1));
}

/**
 * Seals `rows` in the given order with correct links: a chain only order can be wrong in.
 * `late` flags seals late; `hashEpoch` hashes the links of positions in `hashEpochFrom..` with
 * another epoch than the stored one (a segment of another epoch's chain, spliced in).
 */
function sealInOrder(
  store: InMemoryAuditChainStore,
  rows: readonly AuditRowRecord[],
  options: { late?: readonly boolean[]; hashEpoch?: number; hashEpochFrom?: number } = {},
): void {
  let prev = genesisPrev();
  rows.forEach((row, index) => {
    const chainSeq = BigInt(index + 1);
    const rowHash = hashAuditRow(row).hash;
    const late = options.late?.[index] ?? false;
    const spliced = options.hashEpoch !== undefined && index + 1 >= (options.hashEpochFrom ?? 1);
    const chainHash = chainHashOf({
      hashVersion: 1,
      epoch: spliced ? options.hashEpoch! : 1,
      prev,
      chainSeq,
      late,
      rowHash,
    });
    store.seals.push({
      epoch: 1,
      chainSeq,
      auditLogId: row.id,
      auditOccurredAt: row.occurredAt,
      rowHash,
      chainHash,
      late,
      hashVersion: 1,
      sealedAt: START,
    });
    prev = chainHash;
  });
}

const codesOf = (report: VerifyReport) =>
  report.findings.map((finding) => [finding.code, finding.chainSeq]);

describe.each(TEST_MARKETS)('AuditVerifier (PA 8) for market %s', (code) => {
  const market = marketOf(code);
  const other = marketOf(code === 'AU' ? 'ZZ' : 'AU');
  const context = testCallContext(market, 'system');
  let errors: jest.SpyInstance;

  beforeEach(() => {
    errors = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('passes a clean chain, full, from the genesis to the pinned head, in read-only units only', async () => {
    const s = await sealedChain(5, [market, other]);
    const before = s.units.units.length;
    errors.mockClear();

    const report = await s.verifier.verify(context, 'full');

    expect(report).toMatchObject({
      marketId: code,
      mode: 'full',
      pinnedHead: 5n,
      fromSeq: 1n,
      sealsChecked: 5,
      findings: [],
    });
    const verifierUnits = s.units.units.slice(before);
    expect(verifierUnits.length).toBeGreaterThan(0);
    expect(new Set(verifierUnits)).toEqual(new Set(['read-only']));
    expect(errors).not.toHaveBeenCalled();
  });

  it('passes an empty chain', async () => {
    const s = await sealedChain(0, [market]);
    await expect(s.verifier.verify(context, 'full')).resolves.toMatchObject({
      pinnedHead: null,
      fromSeq: null,
      sealsChecked: 0,
      findings: [],
    });
  });

  it('starts an incremental run after the latest checkpoint at or below the head', async () => {
    const s = await sealedChain(3, [market]);
    expect(s.store.checkpoints.map((c) => c.chainSeq)).toEqual([3n]);
    s.store.addRow(rowAt(market, START.subtract({ minutes: 20 })));
    s.store.addRow(rowAt(market, START.subtract({ minutes: 19 })));
    s.clock.advance(Temporal.Duration.from({ minutes: 10 }));
    await s.sealer.run(context);

    await expect(s.verifier.verify(context, 'incremental')).resolves.toMatchObject({
      mode: 'incremental',
      pinnedHead: 5n,
      fromSeq: 4n,
      sealsChecked: 2,
      findings: [],
    });
  });

  it('an incremental run names out-of-range seals from its start up and in unknown epochs only (Mojtaba D1)', async () => {
    const s = await sealedChain(3, [market]);
    s.store.addRow(rowAt(market, START.subtract({ minutes: 20 })));
    s.store.addRow(rowAt(market, START.subtract({ minutes: 19 })));
    s.clock.advance(Temporal.Duration.from({ minutes: 10 }));
    await s.sealer.run(context);
    const outOfRange = Temporal.Instant.from('+010000-01-01T00:00:00Z');
    // Below the walk's start (the checkpoint at 3): only a full run reads there.
    s.store.replaceSeal(1, 2n, { sealedAt: outOfRange }, code);
    // At head + 1, invisible to the head read, and in an epoch nobody opened.
    const [head] = sealsOf(s.store, market).slice(-1);
    const row = rowAt(market, s.clock.now().subtract({ minutes: 1 }));
    s.store.addRow(row);
    s.store.seals.push(
      { ...head!, chainSeq: 6n, auditLogId: row.id, sealedAt: outOfRange },
      { ...head!, epoch: 2, chainSeq: 1n, auditLogId: row.id, sealedAt: outOfRange },
    );

    const incremental = await s.verifier.verify(context, 'incremental');
    expect(incremental.fromSeq).toBe(4n);
    // A seal the range hides leaves its row unsealed to (d); only the range findings matter here.
    expect(
      incremental.findings
        .filter((f) => f.code === 'audit.seal.out-of-range')
        .map(({ code: c, epoch, chainSeq }) => [c, epoch, chainSeq]),
    ).toEqual([
      ['audit.seal.out-of-range', 1, 6n],
      ['audit.seal.out-of-range', 2, 1n],
    ]);
    const full = await s.verifier.verify(context, 'full');
    expect(full.findings.filter((f) => f.code === 'audit.seal.out-of-range')).toHaveLength(3);
  });

  it('passes a late row sealed with late = true', async () => {
    const s = await sealedChain(3, [market]);
    s.store.addRow(rowAt(market, START.subtract({ minutes: 59, seconds: 30 })));
    s.clock.advance(Temporal.Duration.from({ minutes: 6 }));
    await expect(s.sealer.run(context)).resolves.toMatchObject({ late: 1 });

    await expect(s.verifier.verify(context, 'full')).resolves.toMatchObject({ findings: [] });
  });

  describe('tampering (one change, its findings only)', () => {
    it('an edited row is audit.row.mismatch, not also a broken link (c)', async () => {
      const s = await sealedChain(4, [market, other]);
      const row = s.rows.get(code)![1]!;
      const index = s.store.rows.indexOf(row);
      s.store.rows[index] = { ...row, after: { n: 2 } };

      const report = await s.verifier.verify(context, 'full');

      expect(codesOf(report)).toEqual([['audit.row.mismatch', 2n]]);
      expect(errors).toHaveBeenCalledWith(
        expect.objectContaining({
          msg: 'audit.row.mismatch',
          alert: true,
          marketId: code,
          chainSeq: '2',
          auditLogId: row.id,
        }),
      );
      // The finding carries a position, never the row's content.
      expect(JSON.stringify(errors.mock.calls)).not.toContain('"n":2');
      // The other Market is not affected.
      await expect(
        s.verifier.verify(testCallContext(other, 'system'), 'full'),
      ).resolves.toMatchObject({ findings: [] });
    });

    it('a changed row_hash alone is audit.row.mismatch only', async () => {
      const s = await sealedChain(3, [market]);
      s.store.replaceSeal(1, 2n, { rowHash: new Uint8Array(32).fill(1) }, code);

      expect(codesOf(await s.verifier.verify(context, 'full'))).toEqual([
        ['audit.row.mismatch', 2n],
      ]);
    });

    it('a row that canonicalises is a mismatch when its seal carries the fallback form (Hassan N1 c)', async () => {
      const s = await sealedChain(1, [market]);
      // canonicalJson refuses Infinity, so this row is sealed with the fallback hash, whose
      // JSON.stringify writes the number as null.
      const odd = rowAt(market, START.subtract({ minutes: 30 }), { n: Number.POSITIVE_INFINITY });
      s.store.addRow(odd);
      await s.sealer.run(context);
      expect(codesOf(await s.verifier.verify(context, 'full'))).toEqual([
        ['audit.row.noncanonical', 2n],
      ]);

      // The stored row becomes the canonical value the fallback text spelled: still a mismatch.
      const index = s.store.rows.indexOf(odd);
      s.store.rows[index] = { ...odd, after: { n: null } };
      expect(codesOf(await s.verifier.verify(context, 'full'))).toEqual([
        ['audit.row.mismatch', 2n],
      ]);
    });

    it('a deleted seal is audit.chain.gap and its row audit.row.unsealed (a, d)', async () => {
      const s = await sealedChain(5, [market]);
      const removed = sealsOf(s.store, market)[2]!;
      s.store.seals = s.store.seals.filter((seal) => seal !== removed);

      const report = await s.verifier.verify(context, 'full');

      expect(codesOf(report)).toEqual([
        ['audit.chain.gap', 3n],
        ['audit.row.unsealed', null],
      ]);
      expect(report.findings[1]!.auditLogId).toBe(removed.auditLogId);
      expect(report.sealsChecked).toBe(4);
    });

    it('a deleted row is audit.row.missing (d)', async () => {
      const s = await sealedChain(3, [market]);
      const row = s.rows.get(code)![1]!;
      s.store.rows.splice(s.store.rows.indexOf(row), 1);

      expect(codesOf(await s.verifier.verify(context, 'full'))).toEqual([
        ['audit.row.missing', 2n],
      ]);
    });

    it('a row added below the watermark and never sealed is audit.row.unsealed (d)', async () => {
      const s = await sealedChain(3, [market]);
      const extra = rowAt(market, START.subtract({ minutes: 59, seconds: 1 }));
      s.store.addRow(extra);

      const report = await s.verifier.verify(context, 'full');

      expect(report.findings).toEqual([
        expect.objectContaining({ code: 'audit.row.unsealed', auditLogId: extra.id }),
      ]);
    });

    it('a changed chain_hash breaks its own link and the next, and the walk goes on (b)', async () => {
      const s = await sealedChain(5, [market]);
      s.store.replaceSeal(1, 3n, { chainHash: new Uint8Array(32).fill(9) }, code);

      expect(codesOf(await s.verifier.verify(context, 'full'))).toEqual([
        ['audit.chain.broken', 3n],
        ['audit.chain.broken', 4n],
      ]);
    });

    it('a changed checkpoint is audit.checkpoint.mismatch, and an incremental run then walks from the genesis (e)', async () => {
      const s = await sealedChain(3, [market]);
      s.store.checkpoints = s.store.checkpoints.map((c) => ({
        ...c,
        chainHash: new Uint8Array(32).fill(3),
      }));

      expect(codesOf(await s.verifier.verify(context, 'full'))).toEqual([
        ['audit.checkpoint.mismatch', 3n],
      ]);
      const incremental = await s.verifier.verify(context, 'incremental');
      expect(codesOf(incremental)).toEqual([
        ['audit.checkpoint.mismatch', 3n],
        ['audit.checkpoint.mismatch', 3n],
      ]);
      expect(incremental.fromSeq).toBe(1n);
    });

    it('a cut tail is caught by the anchor above the head (f)', async () => {
      const s = await sealedChain(3, [market]);
      expect(s.anchor.checkpoints.map((a) => a.chainSeq)).toEqual([3n]);
      const head = sealsOf(s.store, market)[2]!;
      s.store.seals = s.store.seals.filter((seal) => seal !== head);
      s.store.checkpoints = [];

      expect(codesOf(await s.verifier.verify(context, 'full'))).toEqual([
        ['audit.anchor.mismatch', 3n],
      ]);
    });

    it('a recomputed chain is caught by the anchor, and so are differing versions of one anchor key (f)', async () => {
      const s = await sealedChain(3, [market]);
      s.anchor.extraVersions.set(`${code}/1/3`, [chainHashText(new Uint8Array(32).fill(4))]);

      expect(codesOf(await s.verifier.verify(context, 'full'))).toEqual([
        ['audit.anchor.mismatch', 3n],
      ]);

      // A whole chain recomputed over an edited row: every link holds, the anchor does not.
      s.anchor.extraVersions.clear();
      const rows = s.rows.get(code)!;
      const edited = { ...rows[0]!, after: { n: 5 } };
      s.store.rows[s.store.rows.indexOf(rows[0]!)] = edited;
      s.store.seals = [];
      s.store.checkpoints = [];
      sealInOrder(s.store, [edited, rows[1]!, rows[2]!]);

      expect(codesOf(await s.verifier.verify(context, 'full'))).toEqual([
        ['audit.anchor.mismatch', 3n],
      ]);
    });

    it('a seal time that differs from its row is audit.seal.time-mismatch (g)', async () => {
      const s = await sealedChain(3, [market]);
      const seal = sealsOf(s.store, market)[1]!;
      s.store.replaceSeal(
        1,
        2n,
        { auditOccurredAt: seal.auditOccurredAt.add({ milliseconds: 1 }) },
        code,
      );

      expect(codesOf(await s.verifier.verify(context, 'full'))).toEqual([
        ['audit.seal.time-mismatch', 2n],
      ]);
    });

    it('non-late seals out of (occurred_at, id) order are audit.seal.out-of-order (h)', async () => {
      const s = await sealedChain(0, [market]);
      const first = rowAt(market, START.subtract({ minutes: 30 }));
      const second = rowAt(market, START.subtract({ minutes: 20 }));
      s.store.addRow(first);
      s.store.addRow(second);
      sealInOrder(s.store, [second, first]);

      expect(codesOf(await s.verifier.verify(context, 'full'))).toEqual([
        ['audit.seal.out-of-order', 2n],
      ]);
    });

    it('an unknown hash_version is audit.seal.hash-version (i)', async () => {
      const s = await sealedChain(3, [market]);
      s.store.replaceSeal(1, 3n, { hashVersion: 2 }, code);

      const codes = codesOf(await s.verifier.verify(context, 'full'));
      expect(codes).toContainEqual(['audit.seal.hash-version', 3n]);
      expect(codes.every(([, seq]) => seq === 3n)).toBe(true);
    });

    it('a row later than now + S is audit.row.future (j)', async () => {
      const s = await sealedChain(2, [market]);
      const future = rowAt(market, START.add({ minutes: 6 }));
      s.store.addRow(future);
      s.store.addRow(rowAt(market, START.add({ minutes: 5 })));

      const report = await s.verifier.verify(context, 'full');

      expect(report.findings).toEqual([
        expect.objectContaining({
          code: 'audit.row.future',
          auditLogId: future.id,
          chainSeq: null,
        }),
      ]);
    });

    it('a number that is not a safe integer is audit.row.noncanonical (k)', async () => {
      const s = await sealedChain(1, [market]);
      s.store.addRow(rowAt(market, START.subtract({ minutes: 30 }), { ratio: 1.5 }));
      await s.sealer.run(context);

      expect(codesOf(await s.verifier.verify(context, 'full'))).toEqual([
        ['audit.row.noncanonical', 2n],
      ]);
    });

    it('a seal in an epoch nobody opened is audit.seal.unknown-epoch (a; F12)', async () => {
      const s = await sealedChain(2, [market]);
      const row = rowAt(market, START.subtract({ minutes: 30 }));
      s.store.addRow(row);
      const rowHash = hashAuditRow(row).hash;
      s.store.seals.push({
        epoch: 2,
        chainSeq: 1n,
        auditLogId: row.id,
        auditOccurredAt: row.occurredAt,
        rowHash,
        chainHash: chainHashOf({
          hashVersion: 1,
          epoch: 2,
          prev: genesisPrev(),
          chainSeq: 1n,
          late: false,
          rowHash,
        }),
        late: false,
        hashVersion: 1,
        sealedAt: START,
      });

      const report = await s.verifier.verify(context, 'full');

      expect(report.findings).toEqual([
        expect.objectContaining({
          code: 'audit.seal.unknown-epoch',
          epoch: 2,
          chainSeq: 1n,
          auditLogId: row.id,
        }),
      ]);
    });
  });

  it('stops at the head it pinned however the chain grows meanwhile (Hassan L1)', async () => {
    const s = await sealedChain(3, [market]);
    s.store.afterSealsBetween = () => {
      s.store.afterSealsBetween = null;
      const [head] = sealsOf(s.store, market).slice(-1);
      const row = rowAt(market, START.subtract({ minutes: 10 }));
      s.store.addRow(row);
      const rowHash = hashAuditRow(row).hash;
      s.store.seals.push({
        ...head!,
        chainSeq: 4n,
        auditLogId: row.id,
        auditOccurredAt: row.occurredAt,
        rowHash,
        chainHash: chainHashOf({
          hashVersion: 1,
          epoch: 1,
          prev: head!.chainHash,
          chainSeq: 4n,
          late: false,
          rowHash,
        }),
      });
    };

    await expect(s.verifier.verify(context, 'full')).resolves.toMatchObject({
      pinnedHead: 3n,
      sealsChecked: 3,
      findings: [],
    });
  });

  describe('review fixes (PR #113)', () => {
    /** A bare chain store and verifier with rows a second apart, sealed in order. */
    function bareChain(count: number, endingAt = START.subtract({ minutes: 10 })) {
      const clock = new FixedClock(START);
      const store = new InMemoryAuditChainStore();
      const units = new FakeUnitOfWork();
      const rows = Array.from({ length: count }, (_, index) =>
        rowAt(market, endingAt.subtract({ seconds: count - index })),
      );
      for (const row of rows) store.addRow(row);
      sealInOrder(store, rows);
      return { clock, store, units, rows, verifier: new AuditVerifier(units, store, clock, null) };
    }

    it('lists 1000 findings of a code, counts them all and logs the number suppressed (Mohammad 3, Hassan L2)', async () => {
      const s = bareChain(1005);
      s.store.rows.splice(
        0,
        s.store.rows.length,
        ...s.rows.map((row) => ({ ...row, after: { n: 2 } })),
      );

      const report = await s.verifier.verify(context, 'full');

      expect(report.findings).toHaveLength(1000);
      expect(report.findingTotals).toEqual({ 'audit.row.mismatch': 1005 });
      expect(report.totalsAtLeast).toEqual([]);
      const lines = errors.mock.calls.map(([line]) => line as { msg: string; suppressed?: number });
      expect(lines.filter((line) => line.suppressed !== undefined)).toEqual([
        expect.objectContaining({ msg: 'audit.row.mismatch', suppressed: 5, alert: true }),
      ]);
    });

    it('marks a total that stopped at the read limit as a lower bound', async () => {
      const s = bareChain(1);
      for (let index = 0; index < 1000; index += 1) {
        s.store.addRow(rowAt(market, START.add({ hours: 1, seconds: index })));
      }

      const report = await s.verifier.verify(context, 'full');

      expect(report.findingTotals['audit.row.future']).toBe(1000);
      expect(report.totalsAtLeast).toEqual(['audit.row.future']);
    });

    it('skips empty days in check (d): a row 25 years old costs a few reads, not 9000 (Hassan M3)', async () => {
      const s = bareChain(3);
      const old = rowAt(market, Temporal.Instant.from('2001-06-01T00:00:00Z'));
      s.store.addRow(old);

      const report = await s.verifier.verify(context, 'full');

      expect(report.findings).toEqual([
        expect.objectContaining({ code: 'audit.row.unsealed', auditLogId: old.id }),
      ]);
      expect(s.store.reads.unsealedRows).toBeLessThanOrEqual(3);
      expect(s.store.reads.nextRowTime).toBeLessThanOrEqual(3);
    });

    it('stops check (d) at now - S and reports a watermark in the future (Hassan M3)', async () => {
      const s = bareChain(2);
      const forged = rowAt(market, Temporal.Instant.from('9000-01-01T00:00:00Z'));
      s.store.addRow(forged);
      s.store.seals = [];
      sealInOrder(s.store, [...s.rows, forged]);

      const report = await s.verifier.verify(context, 'full');

      expect(codesOf(report)).toEqual([
        ['audit.seal.watermark-future', 3n],
        ['audit.row.future', null],
      ]);
      expect(s.store.reads.unsealedRows).toBeLessThanOrEqual(2);
      expect(report.complete).toBe(true);
    });

    it('ends a run past its budget with audit.verify.incomplete and no false findings (Hassan M3)', async () => {
      const s = bareChain(1500);
      s.store.afterSealsBetween = () => s.clock.advance(Temporal.Duration.from({ minutes: 10 }));

      const report = await s.verifier.verify(context, 'full');

      expect(report).toMatchObject({ complete: false, sealsChecked: 1000, findings: [] });
      expect(errors).toHaveBeenCalledWith(
        expect.objectContaining({ msg: 'audit.verify.incomplete', alert: true, marketId: code }),
      );
    });

    it('reports every late seal each run, and a late seal above the non-late one before it is out of order (Hassan L3)', async () => {
      const s = bareChain(0);
      const [a, b, c] = [30, 20, 25].map((minutes) => rowAt(market, START.subtract({ minutes })));
      for (const row of [a!, b!, c!]) s.store.addRow(row);
      // c lies between a and b in time: sealed after b as late, it is below b. Fine.
      sealInOrder(s.store, [a!, b!, c!], { late: [false, false, true] });
      const infos = jest.spyOn(Logger.prototype, 'log');

      const report = await s.verifier.verify(context, 'full');

      expect(report).toMatchObject({ lateSeals: 1, findings: [] });
      expect(infos).toHaveBeenCalledWith(
        expect.objectContaining({
          msg: 'audit.verify.late-seal',
          chainSeq: '3',
          auditLogId: c!.id,
        }),
      );

      // A late seal above the non-late seal before it was not a late row.
      const t = bareChain(0);
      const [d, e, f] = [30, 20, 15].map((minutes) => rowAt(market, START.subtract({ minutes })));
      for (const row of [d!, e!, f!]) t.store.addRow(row);
      sealInOrder(t.store, [d!, e!, f!], { late: [false, false, true] });
      expect(codesOf(await t.verifier.verify(context, 'full'))).toEqual([
        ['audit.seal.out-of-order', 3n],
      ]);
    });

    it('a segment of another epoch spliced in breaks every link of it (Sajad M2)', async () => {
      const s = bareChain(0);
      const rows = [40, 30, 20, 10].map((minutes) => rowAt(market, START.subtract({ minutes })));
      for (const row of rows) s.store.addRow(row);
      sealInOrder(s.store, rows, { hashEpoch: 2, hashEpochFrom: 2 });

      expect(codesOf(await s.verifier.verify(context, 'full'))).toEqual([
        ['audit.chain.broken', 2n],
        ['audit.chain.broken', 3n],
        ['audit.chain.broken', 4n],
      ]);
    });

    it('a hash_version lower than the chain so far is audit.seal.hash-version (Sajad L1)', async () => {
      const s = bareChain(3);
      s.store.replaceSeal(1, 3n, { hashVersion: 0 }, code);

      const codes = codesOf(await s.verifier.verify(context, 'full'));
      expect(codes).toContainEqual(['audit.seal.hash-version', 3n]);
      expect(codes.every(([, seq]) => seq === 3n)).toBe(true);
    });

    it('names rows, seals and checkpoints with a time outside the range by id (Hassan M1)', async () => {
      const s = bareChain(3);
      const early = rowAt(market, Temporal.Instant.from('1999-12-31T23:59:59.999Z'));
      const late = rowAt(market, Temporal.Instant.from('+010000-01-01T00:00:00Z'));
      s.store.addRow(early);
      s.store.addRow(late);
      s.store.replaceSeal(
        1,
        3n,
        { sealedAt: Temporal.Instant.from('+010000-01-01T00:00:00Z') },
        code,
      );
      await s.store.insertCheckpoint(market, {
        epoch: 1,
        chainSeq: 2n,
        chainHash: s.store.seals[1]!.chainHash,
        hashVersion: 1,
        createdAt: Temporal.Instant.from('1990-01-01T00:00:00Z'),
      });

      const report = await s.verifier.verify(context, 'full');

      expect(report.complete).toBe(true);
      expect(report.pinnedHead).toBe(2n);
      expect(report.findings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: 'audit.row.out-of-range', auditLogId: early.id }),
          expect.objectContaining({ code: 'audit.row.out-of-range', auditLogId: late.id }),
          expect.objectContaining({ code: 'audit.seal.out-of-range', chainSeq: 3n }),
          expect.objectContaining({ code: 'audit.checkpoint.out-of-range', chainSeq: 2n }),
        ]),
      );
      expect(report.findings).toHaveLength(4);
    });
  });
});
