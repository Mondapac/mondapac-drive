import type { MarketContext } from '@mondapac-drive/shared-kernel';
import { Prisma } from '../../generated/prisma/client';
import { NamedStatementRefusedError } from '../unit-of-work/errors';
import { MAX_LOCK_TIMEOUT_MS } from '../unit-of-work/unit-of-work';

/**
 * The raw SQL of the platform (platform persistence design, "P", 4.2): a closed list of named
 * statements, each with a fixed text, the Market and tenant bound here from the open unit and
 * never from the caller, and every other value a bound parameter.
 *
 * The market guard cannot parse SQL, so it refuses every raw operation except the exact texts
 * below, and for those it checks that the Market and tenant parameters are the open unit's.
 * Recognition is by text, not by object identity, because Prisma copies the `Sql` object
 * before the client extension sees it (measured). Modules cannot reach a raw client at all
 * (`PrismaService.tx` has no raw members; dependency-cruiser keeps them off the guarded
 * client), so this is a second line: a statement built by hand with these texts can lock
 * nothing outside the unit's own Market and tenant. Modules call the list through
 * `PrismaService.namedQuery`, never this file.
 */
export interface RawStatementRequest {
  readonly operation: string;
  readonly args: unknown;
}

const LOCK_TIMEOUT_TEXT = /^SET LOCAL lock_timeout = '([1-9][0-9]{0,3})ms'$/u;

/** True when the guard may let this raw operation through for a unit of `market`. */
export function isApprovedStatement(request: RawStatementRequest, market: MarketContext): boolean {
  const { operation, args } = request;
  if (typeof args !== 'object' || args === null) return false;
  const { sql, values } = args as { sql?: unknown; values?: unknown };
  if (typeof sql !== 'string' || !Array.isArray(values)) return false;
  if (operation === '$queryRaw') {
    if (
      sql === SHARE_PENDING_SUBMISSION_TEXT ||
      sql === SHARE_CERTIFICATION_TYPE_TEXT ||
      sql === SHARE_CERTIFICATION_ISSUER_TEXT
    ) {
      return (
        values.length === 3 &&
        values[0] === market.marketId &&
        values[1] === market.tenantId &&
        typeof values[2] === 'string'
      );
    }
    return (
      sql === LOCK_STOCK_ITEMS_TEXT &&
      values.length === 3 &&
      values[0] === market.marketId &&
      values[1] === market.tenantId &&
      Array.isArray(values[2])
    );
  }
  if (operation === '$executeRaw') {
    const match = LOCK_TIMEOUT_TEXT.exec(sql);
    return match !== null && values.length === 0 && Number(match[1]) <= MAX_LOCK_TIMEOUT_MS;
  }
  return false;
}

/**
 * `SET LOCAL lock_timeout` for the `lockTimeoutMs` option (inventory data design 4.2 L7). The
 * number is checked here as well as at the option, because `SET` takes no parameter and the
 * value is part of the text.
 */
export function lockTimeoutStatement(milliseconds: number): Prisma.Sql {
  if (!Number.isInteger(milliseconds) || milliseconds < 1 || milliseconds > MAX_LOCK_TIMEOUT_MS) {
    throw new RangeError('lock timeout out of range');
  }
  return Prisma.raw(`SET LOCAL lock_timeout = '${milliseconds}ms'`);
}

/** The most stock items one `inventory.lock-stock-items` call locks (inventory data design 4.3). */
export const MAX_LOCKED_STOCK_ITEMS = 1000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** One locked stock item: the columns a stock writer decides from (inventory data design 4.3). */
export interface LockedStockItem {
  readonly id: string;
  readonly offerId: string;
  readonly variantId: string;
  readonly sourceId: string;
  readonly sellerId: string;
  readonly onHand: number;
  readonly retiredAt: Date | null;
  readonly version: number;
}

/** The root a review check or scope reading hangs on, share-locked (certification review R3). */
export interface SharedPendingRoot {
  readonly certificateId: string;
}

/** A certification type row, share-locked (certification slice 12). */
export interface SharedCertificationType {
  readonly status: string;
}

/** A certification issuer row, share-locked (certification slice 12). */
export interface SharedCertificationIssuer {
  readonly state: string;
  readonly typeId: string;
}

/** The checked-in list: statement name to its input and its rows. */
export interface NamedStatements {
  /**
   * Locks stock items `FOR NO KEY UPDATE`, in ascending id order, in the unit's Market and
   * tenant (inventory data design 4.3). `ids` are deduplicated; one to 1,000 of them. The call
   * fails with `rows-missing` when fewer rows come back than distinct ids were given: stock
   * items are never deleted, so a short answer is another Market's id or a bug.
   */
  readonly 'inventory.lock-stock-items': {
    readonly params: { readonly ids: readonly string[] };
    readonly row: LockedStockItem;
  };
  /**
   * Takes `FOR SHARE` on the seller certificate whose pending submission is `submissionId`, in the
   * unit's Market and tenant. `FOR SHARE`, not `FOR KEY SHARE`: only it conflicts with the
   * `FOR NO KEY UPDATE` lock of the version update, so a decision and a recorded check serialise
   * while two checks do not block each other. No row means the submission is not pending.
   */
  readonly 'certification.share-pending-submission': {
    readonly params: { readonly submissionId: string };
    readonly row: SharedPendingRoot;
  };
  /**
   * Takes `FOR SHARE` on a certification type in the unit's Market and tenant and answers its
   * status (certification slice 12). A seller certificate's approval holds it, so a deactivation,
   * which updates the row, either commits first and is seen, or waits for the approval. No row:
   * no such type in this Market.
   */
  readonly 'certification.share-type': {
    readonly params: { readonly typeId: string };
    readonly row: SharedCertificationType;
  };
  /**
   * Takes `FOR SHARE` on a certification issuer in the unit's Market and tenant and answers its
   * state and type (certification slice 12): an approval naming the issuer and a deactivation of
   * the issuer (closed to new, derecognised) serialise, so no approval commits under an issuer
   * the registry has already closed, and the derecognition count sees every approval.
   */
  readonly 'certification.share-issuer': {
    readonly params: { readonly issuerId: string };
    readonly row: SharedCertificationIssuer;
  };
}

export type NamedStatementName = keyof NamedStatements;
export type NamedStatementParams<K extends NamedStatementName> = NamedStatements[K]['params'];
export type NamedStatementRow<K extends NamedStatementName> = NamedStatements[K]['row'];

/** What the open unit lets the runner do: a read-write unit's transaction, nothing else. */
export interface RawRunner {
  query(statement: Prisma.Sql): Promise<unknown>;
  execute(statement: Prisma.Sql): Promise<unknown>;
}

interface RawLockedRow {
  id: string;
  offer_id: string;
  variant_id: string;
  source_id: string;
  seller_id: string;
  on_hand: number;
  retired_at: Date | null;
  version: number;
}

/** The statement of `inventory.lock-stock-items`: Market and tenant first, then the ids. */
export function lockStockItemsStatement(market: MarketContext, ids: readonly string[]): Prisma.Sql {
  return Prisma.sql`
    SELECT s.id, s.offer_id, s.variant_id, s.source_id, s.seller_id, s.on_hand, s.retired_at, s.version
      FROM "inventory"."stock_items" AS s
     WHERE s.market_id = ${market.marketId}
       AND s.tenant_id = ${market.tenantId}
       AND s.id = ANY(${ids}::uuid[])
     ORDER BY s.id
       FOR NO KEY UPDATE OF s`;
}

async function lockStockItems(
  runner: RawRunner,
  market: MarketContext,
  params: NamedStatementParams<'inventory.lock-stock-items'>,
): Promise<LockedStockItem[]> {
  const name = 'inventory.lock-stock-items';
  if (!Array.isArray(params.ids)) throw new NamedStatementRefusedError(name, 'ids-malformed');
  const ids = [...new Set(params.ids as readonly unknown[])];
  if (ids.length === 0) throw new NamedStatementRefusedError(name, 'ids-empty');
  if (ids.length > MAX_LOCKED_STOCK_ITEMS) {
    throw new NamedStatementRefusedError(name, 'ids-too-many');
  }
  if (!ids.every((id): id is string => typeof id === 'string' && UUID.test(id))) {
    throw new NamedStatementRefusedError(name, 'ids-malformed');
  }
  const statement = lockStockItemsStatement(market, ids);
  const rows = (await runner.query(statement)) as RawLockedRow[];
  if (rows.length !== ids.length) throw new NamedStatementRefusedError(name, 'rows-missing');
  return rows.map((row) => ({
    id: row.id,
    offerId: row.offer_id,
    variantId: row.variant_id,
    sourceId: row.source_id,
    sellerId: row.seller_id,
    onHand: row.on_hand,
    retiredAt: row.retired_at,
    version: row.version,
  }));
}

/** The statement of `certification.share-pending-submission`: Market, tenant, then the submission. */
export function sharePendingSubmissionStatement(
  market: MarketContext,
  submissionId: string,
): Prisma.Sql {
  return Prisma.sql`
    SELECT c.id
      FROM "certification"."seller_certifications" AS c
     WHERE c.market_id = ${market.marketId}
       AND c.tenant_id = ${market.tenantId}
       AND c.pending_submission_id = ${submissionId}::uuid
       FOR SHARE OF c`;
}

async function sharePendingSubmission(
  runner: RawRunner,
  market: MarketContext,
  params: NamedStatementParams<'certification.share-pending-submission'>,
): Promise<SharedPendingRoot[]> {
  const name = 'certification.share-pending-submission';
  if (typeof params.submissionId !== 'string' || !UUID.test(params.submissionId)) {
    throw new NamedStatementRefusedError(name, 'ids-malformed');
  }
  const rows = (await runner.query(
    sharePendingSubmissionStatement(market, params.submissionId),
  )) as { id: string }[];
  return rows.map((row) => ({ certificateId: row.id }));
}

/** The statement of `certification.share-type`: Market, tenant, then the type. */
export function shareCertificationTypeStatement(market: MarketContext, typeId: string): Prisma.Sql {
  return Prisma.sql`
    SELECT t.status
      FROM "certification"."certification_types" AS t
     WHERE t.market_id = ${market.marketId}
       AND t.tenant_id = ${market.tenantId}
       AND t.id = ${typeId}::uuid
       FOR SHARE OF t`;
}

/** The statement of `certification.share-issuer`: Market, tenant, then the issuer. */
export function shareCertificationIssuerStatement(
  market: MarketContext,
  issuerId: string,
): Prisma.Sql {
  return Prisma.sql`
    SELECT i.state, i.type_id
      FROM "certification"."issuers" AS i
     WHERE i.market_id = ${market.marketId}
       AND i.tenant_id = ${market.tenantId}
       AND i.id = ${issuerId}::uuid
       FOR SHARE OF i`;
}

async function shareCertificationType(
  runner: RawRunner,
  market: MarketContext,
  params: NamedStatementParams<'certification.share-type'>,
): Promise<SharedCertificationType[]> {
  if (typeof params.typeId !== 'string' || !UUID.test(params.typeId)) {
    throw new NamedStatementRefusedError('certification.share-type', 'ids-malformed');
  }
  const rows = (await runner.query(shareCertificationTypeStatement(market, params.typeId))) as {
    status: string;
  }[];
  return rows.map((row) => ({ status: row.status }));
}

async function shareCertificationIssuer(
  runner: RawRunner,
  market: MarketContext,
  params: NamedStatementParams<'certification.share-issuer'>,
): Promise<SharedCertificationIssuer[]> {
  if (typeof params.issuerId !== 'string' || !UUID.test(params.issuerId)) {
    throw new NamedStatementRefusedError('certification.share-issuer', 'ids-malformed');
  }
  const rows = (await runner.query(shareCertificationIssuerStatement(market, params.issuerId))) as {
    state: string;
    type_id: string;
  }[];
  return rows.map((row) => ({ state: row.state, typeId: row.type_id }));
}

const SHARE_CERTIFICATION_TYPE_TEXT = shareCertificationTypeStatement(
  { marketId: 'XX', tenantId: 'x' } as MarketContext,
  '',
).sql;

const SHARE_CERTIFICATION_ISSUER_TEXT = shareCertificationIssuerStatement(
  { marketId: 'XX', tenantId: 'x' } as MarketContext,
  '',
).sql;

const SHARE_PENDING_SUBMISSION_TEXT = sharePendingSubmissionStatement(
  { marketId: 'XX', tenantId: 'x' } as MarketContext,
  '',
).sql;

/** The text the guard recognises for `inventory.lock-stock-items`, taken from the builder itself. */
const LOCK_STOCK_ITEMS_TEXT = lockStockItemsStatement(
  { marketId: 'XX', tenantId: 'x' } as MarketContext,
  [],
).sql;

/** Runs one named statement on the open read-write unit's transaction. */
export async function runNamedStatement<K extends NamedStatementName>(
  runner: RawRunner,
  market: MarketContext,
  name: K,
  params: NamedStatementParams<K>,
): Promise<NamedStatementRow<K>[]> {
  switch (name) {
    case 'inventory.lock-stock-items':
      return await lockStockItems(
        runner,
        market,
        params as NamedStatementParams<'inventory.lock-stock-items'>,
      );
    case 'certification.share-pending-submission':
      return await sharePendingSubmission(
        runner,
        market,
        params as NamedStatementParams<'certification.share-pending-submission'>,
      );
    case 'certification.share-type':
      return await shareCertificationType(
        runner,
        market,
        params as NamedStatementParams<'certification.share-type'>,
      );
    case 'certification.share-issuer':
      return await shareCertificationIssuer(
        runner,
        market,
        params as NamedStatementParams<'certification.share-issuer'>,
      );
    default:
      throw new Error('Unknown named statement');
  }
}

/** Runs the `lockTimeoutMs` statement; kept beside the other approved builder. */
export async function setLockTimeout(runner: RawRunner, milliseconds: number): Promise<void> {
  await runner.execute(lockTimeoutStatement(milliseconds));
}
