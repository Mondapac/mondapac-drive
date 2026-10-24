import { AsyncLocalStorage } from 'node:async_hooks';
import type { MarketContext } from '@mondapac-drive/shared-kernel';
import type { GuardUnit } from './market-guard';
import type { RawRunner } from './named-statements';

/**
 * The open unit (platform persistence design, "P", 3.2): the one value the persistence
 * layer's `AsyncLocalStorage` carries. The Market the unit was opened with, the read-only
 * flag, the model-delegate view `tx(market)` hands out (the transaction client's, or for a
 * read-only unit the guarded base client's; ADR-0025), and a `closed` flag that `run` sets
 * when the unit ends. No actor, no correlation id, no accessor for modules: only
 * `platform/persistence/` reads it (PA4).
 */
export class OpenUnit implements GuardUnit {
  #closed = false;

  constructor(
    readonly market: MarketContext,
    readonly readOnly: boolean,
    readonly view: object,
    /**
     * The audit models of the same client (Hassan M1 on slice 6a): read only by `auditTx` in
     * `platform/persistence/audit/`; `PrismaService.tx` hands out `view`, which lacks them.
     */
    readonly auditView: object,
    /**
     * The read-write unit's transaction, for the named statements of `named-statements.ts`
     * only (P 4.2); null for a read-only unit, which has no transaction to lock in.
     */
    readonly raw: RawRunner | null = null,
  ) {
    Object.freeze(this);
  }

  /** Set once by `run`; a query that meets a closed unit is refused (ADR-0025 condition (a)). */
  get closed(): boolean {
    return this.#closed;
  }

  close(): void {
    this.#closed = true;
  }
}

/** The single store of open units. Not exported from the persistence module. */
export const unitStorage = new AsyncLocalStorage<OpenUnit>();
