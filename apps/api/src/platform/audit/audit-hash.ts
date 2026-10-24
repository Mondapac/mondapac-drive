import { createHash } from 'node:crypto';
import { canonicalJson, parseContentHash } from '@mondapac-drive/shared-kernel';
import type { ContentHash, Temporal } from '@mondapac-drive/shared-kernel';

/**
 * The hash chain of docs/design/domain/platform-audit.md 6.2, hash version 1. Pure functions of
 * the row as read back from the database and of the predecessor's chain hash: the sealer and
 * the verifier call the same code, so the verifier recomputes exactly what the sealer stored.
 */

/** The hash version this code writes (PA 6.2); the seal and checkpoint CHECKs allow `IN (1)`. */
export const AUDIT_HASH_VERSION = 1;

/** Every hash version the verifier knows (PA 8 (i)). */
export const KNOWN_HASH_VERSIONS: readonly number[] = Object.freeze([1]);

/**
 * The `prev` of `chain_seq = 1` of epoch 1: 32 zero bytes (PA 6.2). A new array each call: a
 * typed array cannot be frozen, so no shared one is handed out.
 */
export function genesisPrev(): Uint8Array {
  return new Uint8Array(32);
}

const ROW_TAG = 'MONDAPAC-AUDIT-ROW-v1';
const RAW_ROW_TAG = 'MONDAPAC-AUDIT-ROW-RAW-v1';
const CHAIN_TAG = 'MONDAPAC-AUDIT-CHAIN-v1';
const HASH_BYTES = 32;

/** One `platform.audit_log` row as read back, with the Prisma types turned into plain values. */
export interface AuditRowRecord {
  readonly id: string;
  readonly marketId: string;
  readonly tenantId: string;
  /** Whole milliseconds: the database refuses anything finer (W3, DP 11.2). */
  readonly occurredAt: Temporal.Instant;
  readonly actorType: string;
  readonly actorId: string | null;
  readonly actingAsId: string | null;
  readonly action: string;
  readonly targetType: string;
  readonly targetId: string;
  /** The jsonb value as parsed, or null for SQL NULL. */
  readonly before: unknown;
  readonly after: unknown;
  readonly correlationId: string;
}

/** The row hash and how it was computed (PA 6.2). */
export interface RowHash {
  readonly hash: Uint8Array;
  /**
   * False when `canonicalJson` refused the row and the fallback hash was used, or when
   * `before` or `after` holds a number that is not a safe integer (PA 6.2, 8 (k)). Every such
   * row is flagged `audit.row.noncanonical`, by the sealer and by the verifier (Hassan I-b).
   */
  readonly canonical: boolean;
  /** True only when the fallback tag was used (`canonicalJson` refused the row). */
  readonly fallback: boolean;
}

/** `occurredAt` as RFC 3339 UTC with exactly three fractional digits and `Z` (PA 6.2). */
export function occurredAtText(instant: Temporal.Instant): string {
  return instant.toString({ fractionalSecondDigits: 3 });
}

/** The object of PA 6.2, in its field order: an absent value is null. */
function rowObject(row: AuditRowRecord): Record<string, unknown> {
  return {
    v: 1,
    id: row.id,
    marketId: row.marketId,
    tenantId: row.tenantId,
    occurredAt: occurredAtText(row.occurredAt),
    actorType: row.actorType,
    actorId: row.actorId ?? null,
    actingAsId: row.actingAsId ?? null,
    action: row.action,
    targetType: row.targetType,
    targetId: row.targetId,
    before: row.before ?? null,
    after: row.after ?? null,
    correlationId: row.correlationId,
  };
}

function sha256(tag: string, body: Uint8Array): Uint8Array {
  return new Uint8Array(
    createHash('sha256')
      .update(Buffer.from(tag, 'utf8'))
      .update(Buffer.of(0))
      .update(body)
      .digest(),
  );
}

/** Whether a jsonb value holds a number that is not a safe integer, at any depth (PA 8 (k)). */
export function holdsUnsafeNumber(value: unknown): boolean {
  const pending: unknown[] = [value];
  while (pending.length > 0) {
    const next = pending.pop();
    if (typeof next === 'number') {
      if (!Number.isSafeInteger(next)) return true;
    } else if (Array.isArray(next)) {
      for (const item of next) pending.push(item);
    } else if (typeof next === 'object' && next !== null) {
      for (const item of Object.values(next)) pending.push(item);
    }
  }
  return false;
}

/**
 * `row_hash` of PA 6.2. The canonical form is the UTF-8 of `canonicalJson` of the row object.
 * The fallback is chosen **only** by whether `canonicalJson` refuses the row as read (Hassan
 * N1 c): then the tag is `MONDAPAC-AUDIT-ROW-RAW-v1` over `JSON.stringify` of the same object,
 * so no row can stop the sealer (Hassan M2). Nothing stored decides the form.
 */
export function hashAuditRow(row: AuditRowRecord): RowHash {
  const object = rowObject(row);
  const unsafe = holdsUnsafeNumber(row.before) || holdsUnsafeNumber(row.after);
  const text = canonicalJson(object);
  if (text.ok) {
    return {
      hash: sha256(ROW_TAG, Buffer.from(text.value, 'utf8')),
      canonical: !unsafe,
      fallback: false,
    };
  }
  return {
    hash: sha256(RAW_ROW_TAG, Buffer.from(JSON.stringify(object), 'utf8')),
    canonical: false,
    fallback: true,
  };
}

/** The input of one link of the chain (PA 6.2). */
export interface ChainLink {
  readonly hashVersion: number;
  readonly epoch: number;
  readonly prev: Uint8Array;
  readonly chainSeq: bigint;
  readonly late: boolean;
  readonly rowHash: Uint8Array;
}

/**
 * `chain_hash` of PA 6.2: SHA-256 of the tag, `0x00`, then a fixed-length input of
 * `uint16be(hash_version) || uint32be(epoch) || prev || uint64be(chain_seq) || uint8(late) ||
 * row_hash` (2 + 4 + 32 + 8 + 1 + 32 bytes). `hash_version` and `epoch` are bound in, so
 * neither can be changed, nor a segment spliced into another epoch, without breaking the link
 * (Hassan L2; Ali 2026-10-08).
 */
export function chainHashOf(link: ChainLink): Uint8Array {
  const { hashVersion, epoch, prev, chainSeq, late, rowHash } = link;
  if (!Number.isInteger(hashVersion) || hashVersion < 0 || hashVersion > 0xffff) {
    throw new RangeError('chainHashOf: hash_version is a uint16');
  }
  if (!Number.isInteger(epoch) || epoch < 1 || epoch > 0xffffffff) {
    throw new RangeError('chainHashOf: epoch is a uint32 from 1');
  }
  if (chainSeq < 1n || chainSeq > 0xffffffffffffffffn) {
    throw new RangeError('chainHashOf: chain_seq is a uint64 from 1');
  }
  if (prev.length !== HASH_BYTES || rowHash.length !== HASH_BYTES) {
    throw new RangeError('chainHashOf: prev and row_hash are 32 bytes');
  }
  const input = Buffer.alloc(2 + 4 + HASH_BYTES + 8 + 1 + HASH_BYTES);
  let offset = input.writeUInt16BE(hashVersion, 0);
  offset = input.writeUInt32BE(epoch, offset);
  input.set(prev, offset);
  offset += HASH_BYTES;
  offset = input.writeBigUInt64BE(chainSeq, offset);
  offset = input.writeUInt8(late ? 1 : 0, offset);
  input.set(rowHash, offset);
  return sha256(CHAIN_TAG, input);
}

/** Byte equality of two hashes, in constant time for equal lengths. */
export function sameHash(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) difference |= a[index]! ^ b[index]!;
  return difference === 0;
}

/** The `sha256:` text form of a 32-byte chain hash, for anchors and log lines only (PA 6.3, F8). */
export function chainHashText(hash: Uint8Array): ContentHash {
  const parsed = parseContentHash(`sha256:${Buffer.from(hash).toString('hex')}`);
  if (!parsed.ok) throw new RangeError('chainHashText: a 32-byte hash is expected');
  return parsed.value;
}
