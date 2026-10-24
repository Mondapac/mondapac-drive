import { setTimeout as sleep } from 'node:timers/promises';
import { isMinted, ok } from '@mondapac-drive/shared-kernel';
import type { MarketContext, Result } from '@mondapac-drive/shared-kernel';
import { Prisma } from '../../generated/prisma/client';
import type { EventDelivery } from '../events/event-delivery';
import {
  InvalidUnitOfWorkOptionsError,
  NestedUnitOfWorkError,
  TransactionConflictError,
  UnmintedMarketContextError,
} from '../unit-of-work/errors';
import {
  CONNECTION_WAIT_MS,
  DEFAULT_UNIT_TIMEOUT_MS,
  MAX_LOCK_TIMEOUT_MS,
  MAX_UNIT_TIMEOUT_MS,
  UNIT_ATTEMPTS,
  type HandledOnce,
  type UnitOfWork,
  type UnitOfWorkOptions,
} from '../unit-of-work/unit-of-work';
import { classifyConflict } from './conflict-classifier';
import {
  auditDelegatesOf,
  modelDelegatesOf,
  type AuditTransaction,
  type GuardedClient,
  type MarketTransaction,
} from './guarded-client';
import type { ModelMap } from './model-map';
import {
  issuedDeliveryFor,
  markDelivered,
  recordInInbox,
  settleDelivery,
} from './outbox/delivery-ledger';
import { setLockTimeout, type RawRunner } from './named-statements';
import { OpenUnit, unitStorage } from './unit-store';

/** Carries an `err` result out of the transaction callback, so that nothing commits (P 3.1 row 3). */
class RollbackSignal<E> extends Error {
  constructor(readonly result: Result<never, E>) {
    super('The unit returned err; rolled back');
  }
}

/**
 * The transaction's raw door, kept in the open unit for `named-statements.ts` alone. The guard
 * still sees every call and lets through only a statement that file registered.
 */
function rawRunnerOf(transaction: {
  $queryRaw(statement: Prisma.Sql): Promise<unknown>;
  $executeRaw(statement: Prisma.Sql): Promise<unknown>;
}): RawRunner {
  return {
    query: (statement) => transaction.$queryRaw(statement),
    execute: (statement) => transaction.$executeRaw(statement),
  };
}

/** The short random pause between attempts (P 3.1 row 7). */
export type RetryPause = (attempt: number) => Promise<void>;
const randomPause: RetryPause = async () => {
  await sleep(5 + Math.floor(Math.random() * 20));
};

/** Refuses the option combinations of P 3.1 rows 8 and 9 (ADR-0025 condition (c)). */
export function checkUnitOfWorkOptions(options: UnitOfWorkOptions): void {
  const { readOnly, isolation, timeoutMs, lockTimeoutMs } = options;
  if (readOnly === true && isolation !== undefined) {
    throw new InvalidUnitOfWorkOptionsError('read-only-with-isolation');
  }
  if (readOnly === true && timeoutMs !== undefined) {
    throw new InvalidUnitOfWorkOptionsError('read-only-with-timeout');
  }
  if (readOnly === true && lockTimeoutMs !== undefined) {
    throw new InvalidUnitOfWorkOptionsError('read-only-with-lock-timeout');
  }
  if (
    lockTimeoutMs !== undefined &&
    (!Number.isInteger(lockTimeoutMs) || lockTimeoutMs < 1 || lockTimeoutMs > MAX_LOCK_TIMEOUT_MS)
  ) {
    throw new InvalidUnitOfWorkOptionsError('lock-timeout-out-of-range');
  }
  if (isolation !== undefined && isolation !== 'serializable') {
    throw new InvalidUnitOfWorkOptionsError('unknown-isolation');
  }
  if (
    timeoutMs !== undefined &&
    (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_UNIT_TIMEOUT_MS)
  ) {
    throw new InvalidUnitOfWorkOptionsError('timeout-out-of-range');
  }
}

/**
 * The UnitOfWork of platform persistence design, "P", section 3, on Prisma interactive
 * transactions over the guarded client.
 *
 * - Read-write: one interactive transaction per attempt, a fresh {@link OpenUnit} around its
 *   client, `work` awaited inside `unitStorage.run` (P 3.2). READ COMMITTED sends no
 *   `isolationLevel` (ADR-0025 decision 2); `serializable` sends `Serializable`. `40001` and
 *   `40P01` are retried, three attempts in all; `55P03` is a conflict at once.
 * - Read-only (ADR-0025 decision 1): no transaction. The unit holds the guarded base client's
 *   model delegates; `work` runs once; the unit is closed in `finally`.
 */
export class PrismaUnitOfWork implements UnitOfWork {
  private readonly readOnlyView: MarketTransaction;
  private readonly readOnlyAuditView: AuditTransaction;

  constructor(
    private readonly client: GuardedClient,
    private readonly map: ModelMap,
    private readonly pause: RetryPause = randomPause,
    // How long a unit waits to start its transaction; only the database test harness passes it.
    private readonly connectionWaitMs: number = CONNECTION_WAIT_MS,
  ) {
    this.readOnlyView = modelDelegatesOf(client, map);
    this.readOnlyAuditView = auditDelegatesOf(client, map);
  }

  async run<T, E>(
    market: MarketContext,
    work: () => Promise<Result<T, E>>,
    options: UnitOfWorkOptions = {},
  ): Promise<Result<T, E>> {
    if (!isMinted(market)) throw new UnmintedMarketContextError();
    checkUnitOfWorkOptions(options);
    if (unitStorage.getStore() !== undefined) throw new NestedUnitOfWorkError();
    return options.readOnly === true
      ? this.runReadOnly(market, work)
      : this.runReadWrite(market, work, options);
  }

  /**
   * P 6.4 (ADR-0006 decision 5): the inbox row, the work when the row is new, and the mark of
   * the delivery, in one read-write unit; on a retry of the unit all three run again. The
   * delivery is settled only after the commit, so the dispatcher sees a failed handler.
   */
  async runOnce<T, E>(
    market: MarketContext,
    delivery: EventDelivery,
    work: () => Promise<Result<T, E>>,
    options: Omit<UnitOfWorkOptions, 'readOnly'> = {},
  ): Promise<Result<HandledOnce<T>, E>> {
    if ((options as UnitOfWorkOptions).readOnly === true) {
      throw new InvalidUnitOfWorkOptionsError('read-only-run-once');
    }
    if (!isMinted(market)) throw new UnmintedMarketContextError();
    const record = issuedDeliveryFor(delivery, market);
    const result = await this.run(
      market,
      async (): Promise<Result<HandledOnce<T>, E>> => {
        const view = unitStorage.getStore()!.view as MarketTransaction;
        let outcome: HandledOnce<T> = { handled: false };
        if (await recordInInbox(view, this.map, delivery, record)) {
          const done = await work();
          if (!done.ok) return done;
          outcome = { handled: true, value: done.value };
        }
        await markDelivered(view, delivery, record);
        return ok(outcome);
      },
      options,
    );
    if (result.ok) settleDelivery(delivery);
    return result;
  }

  private async runReadOnly<T, E>(
    market: MarketContext,
    work: () => Promise<Result<T, E>>,
  ): Promise<Result<T, E>> {
    const unit = new OpenUnit(market, true, this.readOnlyView, this.readOnlyAuditView);
    try {
      return await unitStorage.run(unit, async () => await work());
    } catch (error) {
      // Nothing is retried; a conflict code still surfaces as a conflict (P 3.1 row 9).
      const conflict = classifyConflict(error);
      if (conflict !== null) throw new TransactionConflictError(conflict.sqlState);
      throw error;
    } finally {
      unit.close();
    }
  }

  private async runReadWrite<T, E>(
    market: MarketContext,
    work: () => Promise<Result<T, E>>,
    options: UnitOfWorkOptions,
  ): Promise<Result<T, E>> {
    const transactionOptions = {
      maxWait: this.connectionWaitMs,
      timeout: options.timeoutMs ?? DEFAULT_UNIT_TIMEOUT_MS,
      ...(options.isolation === 'serializable'
        ? { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
        : {}),
    };
    for (let attempt = 1; ; attempt += 1) {
      let unit: OpenUnit | undefined;
      try {
        return await this.client.$transaction(async (transaction) => {
          unit = new OpenUnit(
            market,
            false,
            modelDelegatesOf(transaction, this.map),
            auditDelegatesOf(transaction, this.map),
            rawRunnerOf(transaction),
          );
          const current = unit;
          try {
            const result = await unitStorage.run(current, async () => {
              // First statement of every attempt (inventory data design 4.2 L7).
              if (options.lockTimeoutMs !== undefined) {
                await setLockTimeout(current.raw!, options.lockTimeoutMs);
              }
              return await work();
            });
            if (!result.ok) throw new RollbackSignal(result);
            return result;
          } finally {
            // Before COMMIT: a query `work` did not await is refused, not committed.
            current.close();
          }
        }, transactionOptions);
      } catch (error) {
        if (error instanceof RollbackSignal) return error.result;
        const conflict = classifyConflict(error);
        if (conflict === null) throw error;
        if (!conflict.retry || attempt >= UNIT_ATTEMPTS) {
          throw new TransactionConflictError(conflict.sqlState);
        }
        await this.pause(attempt);
      } finally {
        unit?.close();
      }
    }
  }
}
