import { createHash } from 'node:crypto';
import { canonicalJson, Temporal } from '@mondapac-drive/shared-kernel';
import {
  AUDIT_HASH_VERSION,
  chainHashOf,
  chainHashText,
  genesisPrev,
  hashAuditRow,
  holdsUnsafeNumber,
  occurredAtText,
  sameHash,
  type AuditRowRecord,
} from './audit-hash';

// docs/design/domain/platform-audit.md 6.2 and 16 ("golden hash vectors", "the fallback row
// hash"). The golden values below are checked in: a change to the construction changes them,
// and the test fails until a new hash version is designed (PA 6.2: a version change never goes
// back). Each is also recomputed here from the byte layout of 6.2, independently of the code.

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');

/** A fixed row of each Market fixture, as read back from the database. */
const ROW_AU: AuditRowRecord = {
  id: '01990000-0000-7000-8000-000000000001',
  marketId: 'AU',
  tenantId: 'mondapac',
  occurredAt: Temporal.Instant.from('2026-10-08T06:00:00.250Z'),
  actorType: 'ANONYMOUS',
  actorId: null,
  actingAsId: null,
  action: 'identity.seller-access.founded',
  targetType: 'identity.seller-access',
  targetId: '01990000-0000-7000-8000-0000000000aa',
  before: null,
  after: {
    state: 'pending',
    origin: 'self',
    sellerId: '01990000-0000-7000-8000-0000000000aa',
    accountId: '01990000-0000-7000-8000-0000000000bb',
    boundSubjectId: '01990000-0000-7000-8000-0000000000bb',
  },
  correlationId: 'req-0001',
};
const ROW_ZZ: AuditRowRecord = {
  ...ROW_AU,
  id: '01990000-0000-7000-8000-000000000002',
  marketId: 'ZZ',
  occurredAt: Temporal.Instant.from('2026-10-08T06:00:00Z'),
  actorType: 'SYSTEM',
  action: 'identity.role.seeded',
  targetType: 'identity.role',
  targetId: '01990000-0000-7000-8000-0000000000cc',
  after: { scope: 'seller', kind: 'system', seedVersion: 1 },
};

/** The canonical row of PA 6.2, written out by hand for ROW_AU. */
const CANONICAL_AU =
  '{"actingAsId":null,"action":"identity.seller-access.founded","actorId":null,' +
  '"actorType":"ANONYMOUS","after":{"accountId":"01990000-0000-7000-8000-0000000000bb",' +
  '"boundSubjectId":"01990000-0000-7000-8000-0000000000bb","origin":"self",' +
  '"sellerId":"01990000-0000-7000-8000-0000000000aa","state":"pending"},"before":null,' +
  '"correlationId":"req-0001","id":"01990000-0000-7000-8000-000000000001","marketId":"AU",' +
  '"occurredAt":"2026-10-08T06:00:00.250Z","targetId":"01990000-0000-7000-8000-0000000000aa",' +
  '"targetType":"identity.seller-access","tenantId":"mondapac","v":1}';

/** SHA-256 of `tag || 0x00 || body`, the frame of every hash of 6.2. */
function tagged(tag: string, body: Buffer): string {
  return createHash('sha256')
    .update(Buffer.concat([Buffer.from(tag, 'utf8'), Buffer.of(0), body]))
    .digest('hex');
}

/** The link of 6.2 laid out by hand: 2 + 4 + 32 + 8 + 1 + 32 bytes after the tag. */
function linkByHand(
  version: number,
  epoch: number,
  prev: Buffer,
  seq: bigint,
  late: boolean,
  rowHash: Buffer,
): string {
  const body = Buffer.alloc(79);
  body.writeUInt16BE(version, 0);
  body.writeUInt32BE(epoch, 2);
  prev.copy(body, 6);
  body.writeBigUInt64BE(seq, 38);
  body.writeUInt8(late ? 1 : 0, 46);
  rowHash.copy(body, 47);
  return tagged('MONDAPAC-AUDIT-CHAIN-v1', body);
}

// Checked in (PA 16). Recomputed by hand below as well.
const GOLDEN = {
  rowAu: 'c64f07711f04dd4b7092d6278c1fa2ab7e8efb3cfdb4409b540b8fbb49b90a18',
  rowZz: 'fb0cfeec87643eb4a8fea32614edb57738470ff366508bd1dd07f988d00ad50c',
  chain1: '70a79d3f5c3a6e4169c966843cd0684aedc52abeaf02556c830becb392d66474',
  chain2Late: '6ef5cbf7e3735ce53573f9b755e711cd20d72efde5487f7040d1feecc46b75bb',
  epoch2: 'bed3cb15fe3662fa8da55d9d207e27ae76793cf2a75786611d9691e20b6aef1d',
  fallback: '16e6aea0295d83e1931c40c498e0d565f045745962bfd4170f3bebc081a33d67',
};

describe('the row hash of hash version 1 (PA 6.2)', () => {
  it('hashes the canonical JSON of the row object, as written out by hand', () => {
    expect(canonicalJson({ ...ROW_AU, v: 1, occurredAt: '2026-10-08T06:00:00.250Z' })).toEqual({
      ok: true,
      value: CANONICAL_AU,
    });
    const hash = hashAuditRow(ROW_AU);

    expect(hash).toEqual({
      hash: expect.any(Uint8Array) as unknown,
      canonical: true,
      fallback: false,
    });
    expect(hex(hash.hash)).toBe(tagged('MONDAPAC-AUDIT-ROW-v1', Buffer.from(CANONICAL_AU, 'utf8')));
  });

  it('gives the checked-in golden values for a row of each Market fixture', () => {
    expect(hex(hashAuditRow(ROW_AU).hash)).toBe(GOLDEN.rowAu);
    expect(hex(hashAuditRow(ROW_ZZ).hash)).toBe(GOLDEN.rowZz);
  });

  it('writes occurredAt with exactly three fractional digits and Z', () => {
    expect(occurredAtText(Temporal.Instant.from('2026-10-08T06:00:00Z'))).toBe(
      '2026-10-08T06:00:00.000Z',
    );
    expect(occurredAtText(Temporal.Instant.from('2026-10-08T06:00:00.25Z'))).toBe(
      '2026-10-08T06:00:00.250Z',
    );
  });

  it('does not depend on the key order or number text of the jsonb as read back', () => {
    const reordered: AuditRowRecord = {
      ...ROW_AU,
      after: Object.fromEntries(Object.entries(ROW_AU.after as object).reverse()),
    };

    expect(sameHash(hashAuditRow(reordered).hash, hashAuditRow(ROW_AU).hash)).toBe(true);
  });

  it('changes when any column changes, absent values included', () => {
    const base = hex(hashAuditRow(ROW_AU).hash);
    for (const change of [
      { tenantId: 'other' },
      { marketId: 'ZZ' },
      { occurredAt: ROW_AU.occurredAt.add({ milliseconds: 1 }) },
      { actorId: '01990000-0000-7000-8000-0000000000dd' },
      { before: {} },
      { correlationId: 'req-0002' },
    ] satisfies Partial<AuditRowRecord>[]) {
      expect(hex(hashAuditRow({ ...ROW_AU, ...change }).hash)).not.toBe(base);
    }
  });
});

describe('the fallback row hash (PA 6.2; Hassan M2, N1 c, I-b)', () => {
  // A jsonb number beyond the double range reads back as Infinity, which canonicalJson refuses.
  const BEYOND: AuditRowRecord = { ...ROW_AU, after: { count: Number.POSITIVE_INFINITY } };

  it('seals a row canonicalJson refuses with the RAW tag over JSON.stringify, flagged noncanonical', () => {
    const hash = hashAuditRow(BEYOND);
    const object = {
      v: 1,
      id: BEYOND.id,
      marketId: BEYOND.marketId,
      tenantId: BEYOND.tenantId,
      occurredAt: '2026-10-08T06:00:00.250Z',
      actorType: BEYOND.actorType,
      actorId: null,
      actingAsId: null,
      action: BEYOND.action,
      targetType: BEYOND.targetType,
      targetId: BEYOND.targetId,
      before: null,
      after: { count: Number.POSITIVE_INFINITY },
      correlationId: BEYOND.correlationId,
    };

    expect(hash.canonical).toBe(false);
    expect(hash.fallback).toBe(true);
    expect(hex(hash.hash)).toBe(
      tagged('MONDAPAC-AUDIT-ROW-RAW-v1', Buffer.from(JSON.stringify(object), 'utf8')),
    );
    expect(hex(hash.hash)).toBe(GOLDEN.fallback);
  });

  it('is chosen only by whether canonicalJson refuses: a canonical row never gets it', () => {
    const hash = hashAuditRow(ROW_AU);

    expect(hash.fallback).toBe(false);
    expect(hex(hash.hash)).not.toBe(
      tagged('MONDAPAC-AUDIT-ROW-RAW-v1', Buffer.from(JSON.stringify(ROW_AU), 'utf8')),
    );
  });

  it('writes a number beyond the double range as null, so such rows are always flagged', () => {
    const asNull: AuditRowRecord = { ...ROW_AU, after: { count: null } };

    // Two different stored values, one fallback hash: acceptable only because both are flagged.
    expect(hashAuditRow({ ...ROW_AU, after: { count: Number.NEGATIVE_INFINITY } }).hash).toEqual(
      hashAuditRow(BEYOND).hash,
    );
    expect(hashAuditRow(asNull).fallback).toBe(false);
  });

  it('flags a canonical row whose before or after holds a number that is not a safe integer (8 (k))', () => {
    expect(hashAuditRow({ ...ROW_AU, after: { n: 2 ** 53 } })).toMatchObject({
      canonical: false,
      fallback: false,
    });
    expect(hashAuditRow({ ...ROW_AU, before: { list: [1, 1.5] } }).canonical).toBe(false);
    expect(holdsUnsafeNumber({ a: [{ b: 9_007_199_254_740_991 }] })).toBe(false);
    expect(holdsUnsafeNumber({ a: [{ b: -9_007_199_254_740_992 }] })).toBe(true);
  });
});

describe('the chain hash of hash version 1 (PA 6.2; Hassan L2; Ali 2026-10-08)', () => {
  const rowHash = hashAuditRow(ROW_AU).hash;

  it('links the genesis, then a late seal, as laid out by hand, to the golden values', () => {
    const first = chainHashOf({
      hashVersion: AUDIT_HASH_VERSION,
      epoch: 1,
      prev: genesisPrev(),
      chainSeq: 1n,
      late: false,
      rowHash,
    });
    const second = chainHashOf({
      hashVersion: 1,
      epoch: 1,
      prev: first,
      chainSeq: 2n,
      late: true,
      rowHash: hashAuditRow(ROW_ZZ).hash,
    });

    expect(hex(first)).toBe(linkByHand(1, 1, Buffer.alloc(32), 1n, false, Buffer.from(rowHash)));
    expect(hex(second)).toBe(
      linkByHand(1, 1, Buffer.from(first), 2n, true, Buffer.from(hashAuditRow(ROW_ZZ).hash)),
    );
    expect(hex(first)).toBe(GOLDEN.chain1);
    expect(hex(second)).toBe(GOLDEN.chain2Late);
  });

  it('binds the epoch: the same link in epoch 2 gives another hash (golden)', () => {
    const epoch2 = chainHashOf({
      hashVersion: 1,
      epoch: 2,
      prev: genesisPrev(),
      chainSeq: 1n,
      late: false,
      rowHash,
    });

    expect(hex(epoch2)).toBe(linkByHand(1, 2, Buffer.alloc(32), 1n, false, Buffer.from(rowHash)));
    expect(hex(epoch2)).toBe(GOLDEN.epoch2);
    expect(hex(epoch2)).not.toBe(GOLDEN.chain1);
  });

  it('binds the hash version, the sequence, the late flag, the predecessor and the row', () => {
    const base = {
      hashVersion: 1,
      epoch: 1,
      prev: genesisPrev(),
      chainSeq: 1n,
      late: false,
      rowHash,
    };
    const reference = hex(chainHashOf(base));
    for (const change of [
      { hashVersion: 2 },
      { chainSeq: 2n },
      { late: true },
      { prev: new Uint8Array(32).fill(1) },
      { rowHash: new Uint8Array(32).fill(2) },
    ]) {
      expect(hex(chainHashOf({ ...base, ...change }))).not.toBe(reference);
    }
  });

  it.each([
    ['a hash version beyond uint16', { hashVersion: 0x10000 }],
    ['epoch 0', { epoch: 0 }],
    ['chain_seq 0', { chainSeq: 0n }],
    ['a short predecessor', { prev: new Uint8Array(31) }],
    ['a long row hash', { rowHash: new Uint8Array(33) }],
  ])('refuses %s', (_case, change) => {
    expect(() =>
      chainHashOf({
        hashVersion: 1,
        epoch: 1,
        prev: genesisPrev(),
        chainSeq: 1n,
        late: false,
        rowHash,
        ...change,
      }),
    ).toThrow(RangeError);
  });

  it('hands out a new genesis each time, and writes a hash as sha256: text at the boundaries', () => {
    const genesis = genesisPrev();
    genesis[0] = 1;

    expect(genesisPrev()).toEqual(new Uint8Array(32));
    expect(chainHashText(new Uint8Array(32).fill(0xab))).toBe(`sha256:${'ab'.repeat(32)}`);
    expect(() => chainHashText(new Uint8Array(31))).toThrow(RangeError);
  });
});
