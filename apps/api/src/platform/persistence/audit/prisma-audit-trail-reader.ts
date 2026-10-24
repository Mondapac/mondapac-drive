import { err, ok, Temporal } from '@mondapac-drive/shared-kernel';
import type { MarketContext, Result } from '@mondapac-drive/shared-kernel';
import type { AuditActionCatalogue } from '../../audit/audit-action-catalogue';
import { AUDIT_TIME_RANGE } from '../../audit/audit-chain-policy';
import {
  AuditReadRefusedError,
  MAX_AUDIT_TRAIL_PAGE,
  type AuditTrailEntry,
  type AuditTrailQuery,
  type AuditTrailReader,
} from '../../audit/audit-trail-reader';
import { auditTx } from './audit-transaction';

/** As the chain store: a time outside the range would come back as an Invalid Date. */
const IN_RANGE = {
  gte: new Date(AUDIT_TIME_RANGE.from.epochMilliseconds),
  lt: new Date(AUDIT_TIME_RANGE.until.epochMilliseconds),
};
const NEWEST_FIRST = [{ occurredAt: 'desc' as const }, { id: 'desc' as const }];
const COLUMNS = {
  id: true,
  occurredAt: true,
  actorType: true,
  actorId: true,
  before: true,
  after: true,
} as const;

interface TrailRow {
  readonly id: string;
  readonly occurredAt: Date;
  readonly actorType: string;
  readonly actorId: string | null;
  readonly before: unknown;
  readonly after: unknown;
}

const entryOf = (row: TrailRow): AuditTrailEntry => ({
  id: row.id,
  occurredAt: Temporal.Instant.fromEpochMilliseconds(row.occurredAt.getTime()),
  actorType: row.actorType as AuditTrailEntry['actorType'],
  actorId: row.actorId,
  before: row.before ?? null,
  after: row.after ?? null,
});

/** The {@link AuditTrailReader} of one owner, on the audit models of the open unit (`auditTx`). */
class PrismaAuditTrailReader implements AuditTrailReader {
  constructor(
    private readonly owner: string,
    private readonly catalogue: AuditActionCatalogue,
  ) {}

  async history(
    market: MarketContext,
    query: AuditTrailQuery,
  ): Promise<Result<readonly AuditTrailEntry[], { readonly code: 'cursor.unknown' }>> {
    if (!this.catalogue.sealed) throw new AuditReadRefusedError('catalogue-not-sealed');
    const definition = this.catalogue.get(query.action);
    if (definition === undefined) throw new AuditReadRefusedError('action-not-in-catalogue');
    if (definition.owner !== this.owner) throw new AuditReadRefusedError('action-of-another-owner');
    const { limit } = query;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_AUDIT_TRAIL_PAGE) {
      throw new AuditReadRefusedError('limit-invalid');
    }
    const audit = auditTx(market);
    // Market, target type and target id lead the target index; the action narrows within it.
    const history = {
      marketId: market.marketId,
      targetType: definition.targetType,
      targetId: query.targetId,
      action: definition.action,
      occurredAt: IN_RANGE,
    };
    let below: object[] = [];
    if (query.after !== null) {
      const cursor = await audit.auditLog.findFirst({
        where: { ...history, id: query.after },
        select: { id: true, occurredAt: true },
      });
      if (cursor === null) return err({ code: 'cursor.unknown' });
      // `(occurred_at, id) < cursor`, as `AND` parts.
      below = [
        { occurredAt: { lte: cursor.occurredAt } },
        { OR: [{ occurredAt: { lt: cursor.occurredAt } }, { id: { lt: cursor.id } }] },
      ];
    }
    const rows: TrailRow[] = await audit.auditLog.findMany({
      where: { ...history, AND: below },
      orderBy: NEWEST_FIRST,
      take: limit,
      select: COLUMNS,
    });
    return ok(rows.map(entryOf));
  }
}

/** The reader of one owner (a module's folder name), for `PersistenceModule.auditTrailReaderFor`. */
export function createAuditTrailReader(
  owner: string,
  catalogue: AuditActionCatalogue,
): AuditTrailReader {
  return new PrismaAuditTrailReader(owner, catalogue);
}
