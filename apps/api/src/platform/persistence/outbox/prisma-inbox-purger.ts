import type { MarketContext, Temporal } from '@mondapac-drive/shared-kernel';
import type { InboxPurger } from '../../events/inbox-retention';
import type { ModelMap } from '../model-map';
import type { PrismaRoot } from '../prisma-root';

/** A schema or table name of the generated model map, as a quoted identifier. */
const IDENTIFIER = /^[a-z][a-z0-9_]*$/;

/**
 * The inbox purge of `platform.inbox-retention` (handoff 35): one bounded DELETE per module
 * inbox the model map names, for one Market and tenant. The identifiers come from the
 * generated map (never from input) and are checked; every value is a bound parameter. Runs on
 * the base client outside any unit, like the relay; the application role holds DELETE on the
 * inboxes only (migration 20261027050000).
 */
export class PrismaInboxPurger implements InboxPurger {
  readonly #inboxes: readonly { readonly module: string; readonly table: string }[];

  constructor(
    private readonly root: PrismaRoot,
    map: ModelMap,
  ) {
    this.#inboxes = Object.entries(map.modules)
      .filter(([, entry]) => entry.inboxModel !== null)
      .map(([module, entry]) => {
        const model = map.models[entry.inboxModel!];
        const schema = model?.schema ?? entry.schema;
        if (model === undefined || !IDENTIFIER.test(schema) || !IDENTIFIER.test(model.table)) {
          throw new Error(`The inbox of module "${module}" is not a plain table`);
        }
        return { module, table: `"${schema}"."${model.table}"` };
      });
  }

  /** The modules whose inbox is purged, for tests and the job's log. */
  get modules(): readonly string[] {
    return this.#inboxes.map((inbox) => inbox.module);
  }

  async purgeHandled(
    market: MarketContext,
    before: Temporal.Instant,
    limit: number,
  ): Promise<Readonly<Record<string, number>>> {
    const cutOff = new Date(before.epochMilliseconds);
    const deleted: Record<string, number> = {};
    for (const { module, table } of this.#inboxes) {
      deleted[module] = await this.root.$executeRawUnsafe(
        `DELETE FROM ${table} WHERE (event_id, handler) IN (
           SELECT event_id, handler FROM ${table}
            WHERE market_id = $1 AND tenant_id = $2 AND processed_at < $3
            LIMIT $4)`,
        market.marketId,
        market.tenantId,
        cutOff,
        limit,
      );
    }
    return deleted;
  }
}
