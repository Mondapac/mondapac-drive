import {
  BOUND_SUBJECT_FIELD,
  canonicalJson,
  encodeAuditFields,
  isMinted,
  parseCorrelationId,
  parseId,
} from '@mondapac-drive/shared-kernel';
import type {
  ActorContext,
  AuditActionDefinition,
  AuditFields,
  CallContext,
  Clock,
  IdGenerator,
  JsonObject,
} from '@mondapac-drive/shared-kernel';
import type { AuditActionCatalogue } from '../../audit/audit-action-catalogue';
import {
  AuditWriteRefusedError,
  MAX_AUDIT_SIDE_BYTES,
  type AuditWriter,
} from '../../audit/audit-writer';
import type { PermissionKeyLookup } from '../../events/outbox-writer';
import { auditTx } from './audit-transaction';
import { unitStorage } from '../unit-store';

/** One row of `platform.audit_log` (docs/design/data/platform.md 2), as the guarded delegate takes it. */
interface AuditRow {
  readonly id: string;
  readonly marketId: string;
  readonly tenantId: string;
  readonly occurredAt: Date;
  readonly actorType: 'USER' | 'SYSTEM' | 'ANONYMOUS';
  readonly actorId: string | null;
  readonly actingAsId: null;
  readonly action: string;
  readonly targetType: string;
  readonly targetId: string;
  readonly before?: JsonObject;
  readonly after?: JsonObject;
  readonly correlationId: string;
}

/** PA W2: the actor columns come from the context only. */
function actorColumns(actor: ActorContext): Pick<AuditRow, 'actorType' | 'actorId'> {
  switch (actor.kind) {
    case 'authenticated':
      return { actorType: 'USER', actorId: actor.accountId };
    case 'system':
      return { actorType: 'SYSTEM', actorId: null };
    case 'anonymous':
      return { actorType: 'ANONYMOUS', actorId: null };
  }
}

/**
 * The audit writer of docs/design/domain/platform-audit.md 3.1, bound to one owner (a module,
 * or `platform.<component>`). It writes through `platform.audit_log`'s model of the open unit
 * (`auditTx`, the unit's internal audit view, which `PrismaService.tx` does not expose), so
 * the market guard checks the row's Market and tenant like any other
 * write (P 4), and the unit's commit or rollback decides the row with the audited change.
 */
class PrismaAuditWriter implements AuditWriter {
  constructor(
    private readonly owner: string,
    private readonly catalogue: AuditActionCatalogue,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly permissionKeys: PermissionKeyLookup,
  ) {}

  async record(context: CallContext, entry: unknown): Promise<void> {
    // Foundations 3.7: a context copied, spread or rebuilt from JSON is refused.
    if (!isMinted(context)) throw new AuditWriteRefusedError('context-not-minted');
    // W1: the caller's unit, read-write, of the context's Market; never one of our own.
    const unit = unitStorage.getStore();
    if (unit === undefined || unit.closed) throw new AuditWriteRefusedError('no-open-unit');
    if (unit.readOnly) throw new AuditWriteRefusedError('read-only-unit');
    const market = context.market;
    if (
      !isMinted(market) ||
      market.marketId !== unit.market.marketId ||
      market.tenantId !== unit.market.tenantId
    ) {
      throw new AuditWriteRefusedError('market-mismatch');
    }
    if (!parseCorrelationId(context.correlationId).ok) {
      throw new AuditWriteRefusedError('correlation-id-invalid');
    }
    if (!this.catalogue.sealed) throw new AuditWriteRefusedError('catalogue-not-sealed');

    const row = this.rowOf(context, entry);
    await auditTx(market).auditLog.create({ data: row });
  }

  private rowOf(context: CallContext, entry: unknown): AuditRow {
    if (typeof entry !== 'object' || entry === null) {
      throw new AuditWriteRefusedError('entry-invalid');
    }
    const { action, targetType, targetId, before, after } = entry as Record<string, unknown>;
    if (typeof action !== 'string') throw new AuditWriteRefusedError('entry-invalid');

    const definition = this.catalogue.get(action);
    if (definition === undefined) {
      throw new AuditWriteRefusedError(
        action.startsWith(`${this.owner}.`) ? 'action-not-in-catalogue' : 'action-of-another-owner',
      );
    }
    if (definition.owner !== this.owner) {
      throw new AuditWriteRefusedError('action-of-another-owner');
    }
    if (targetType !== definition.targetType) {
      throw new AuditWriteRefusedError('target-type-mismatch');
    }
    if (!this.isTargetId(definition, targetId)) {
      throw new AuditWriteRefusedError('target-id-invalid');
    }
    const actor = context.actor;
    if (!definition.actors.includes(actor.kind)) {
      throw new AuditWriteRefusedError('actor-not-allowed');
    }

    const encodedBefore = this.side('before', definition.before, before);
    const encodedAfter = this.side('after', definition.after, after);
    // W4a: an anonymous row names the account or invitation its credential binds.
    if (
      actor.kind === 'anonymous' &&
      (encodedAfter === null || typeof encodedAfter[BOUND_SUBJECT_FIELD] !== 'string')
    ) {
      throw new AuditWriteRefusedError('bound-subject-missing');
    }

    // W3: read inside the unit, cut to whole milliseconds (the database refuses anything finer).
    const occurredAt = new Date(this.clock.now().epochMilliseconds);
    return {
      id: this.ids.next<'AuditLog'>(),
      marketId: context.market.marketId,
      tenantId: context.market.tenantId,
      occurredAt,
      ...actorColumns(actor),
      actingAsId: null,
      action: definition.action,
      targetType: definition.targetType,
      targetId: targetId as string,
      ...(encodedBefore === null ? {} : { before: encodedBefore }),
      ...(encodedAfter === null ? {} : { after: encodedAfter }),
      correlationId: context.correlationId,
    };
  }

  private isTargetId(definition: AuditActionDefinition, targetId: unknown): boolean {
    if (typeof targetId !== 'string') return false;
    const kind = definition.targetId;
    return kind.kind === 'id' ? parseId(targetId).ok : kind.values.includes(targetId);
  }

  /** W4: exactly the declared fields, each list within its maximum, at most 4 KB canonical. */
  private side(
    name: 'before' | 'after',
    fields: AuditFields | null,
    values: unknown,
  ): JsonObject | null {
    if (fields === null) {
      if (values === null || values === undefined) return null;
      throw new AuditWriteRefusedError(
        name === 'before' ? 'before-undeclared' : 'after-undeclared',
      );
    }
    const encoded = encodeAuditFields(fields, values, this.permissionKeys);
    if (!encoded.ok) {
      const { field, problem } = encoded.error;
      if (problem === 'too-long') throw new AuditWriteRefusedError('list-too-long', field);
      throw new AuditWriteRefusedError(
        name === 'before' ? 'before-invalid' : 'after-invalid',
        field,
      );
    }
    const text = canonicalJson(encoded.value);
    if (!text.ok || Buffer.byteLength(text.value, 'utf8') > MAX_AUDIT_SIDE_BYTES) {
      throw new AuditWriteRefusedError(name === 'before' ? 'before-too-large' : 'after-too-large');
    }
    return encoded.value;
  }
}

/** What {@link createAuditWriter} needs; all of it comes from the global platform providers. */
export interface AuditWriterDependencies {
  readonly catalogue: AuditActionCatalogue;
  readonly ids: IdGenerator;
  readonly clock: Clock;
  readonly permissionKeys: PermissionKeyLookup;
}

/**
 * The writer of one owner (PA 2). Called only by `PersistenceModule.auditWriterFor`, which a
 * module's Nest module uses to bind its own `AUDIT_WRITER`; there is no injectable factory.
 */
export function createAuditWriter(
  owner: string,
  dependencies: AuditWriterDependencies,
): AuditWriter {
  const { catalogue, ids, clock, permissionKeys } = dependencies;
  return new PrismaAuditWriter(owner, catalogue, ids, clock, permissionKeys);
}
