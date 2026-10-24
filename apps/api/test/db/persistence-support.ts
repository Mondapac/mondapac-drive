import { randomUUID } from 'node:crypto';
import type { MarketContext } from '@mondapac-drive/shared-kernel';
import { Client as PgClient } from 'pg';
import { testMarketContext } from '@mondapac-drive/shared-kernel/testing';
import { MODEL_MAP } from '../../src/generated/model-map';
import { PLATFORM_TENANT_ID } from '../../src/platform/market-context/tenant';
import {
  createGuardedClient,
  type GuardedClient,
} from '../../src/platform/persistence/guarded-client';
import type { ModelMap } from '../../src/platform/persistence/model-map';
import { PrismaRoot } from '../../src/platform/persistence/prisma-root';
import { PrismaService } from '../../src/platform/persistence/prisma.service';
import {
  PrismaUnitOfWork,
  type RetryPause,
} from '../../src/platform/persistence/prisma-unit-of-work';
import { TransactionConflictError } from '../../src/platform/unit-of-work/errors';
import { testAppConfig } from '../support/test-config';
import { testDatabaseUrl } from './test-database';

/** The generated map, as the guard reads it. */
export const modelMap: ModelMap = MODEL_MAP;

/** The persistence layer of one process, built as `PersistenceModule` builds it, without Nest. */
export interface Persistence {
  readonly root: PrismaRoot;
  readonly client: GuardedClient;
  readonly service: PrismaService;
  readonly unitOfWork: PrismaUnitOfWork;
  close(): Promise<void>;
}

export interface PersistenceOptions {
  /** Environment overrides for the AppConfig (`DATABASE_POOL_MAX`). */
  readonly env?: Record<string, string>;
  /** Extra connection-string parameters (`application_name`, test-only `options`). */
  readonly urlParameters?: Record<string, string>;
  readonly pause?: RetryPause;
  /** The database's application URL; the run database by default. */
  readonly databaseUrl?: string;
  /** The wait for a connection; {@link TEST_CONNECTION_WAIT_MS} by default. */
  readonly connectionWaitMs?: number;
}

/**
 * How long a test unit waits for a connection and to start its transaction. Longer than the
 * application's 2 s because parallel spec files load the runner's CPU (owner decision
 * 2026-10-20); the application's own wait is unchanged.
 */
export const TEST_CONNECTION_WAIT_MS = 10_000;

/** A pool of the application role on the run's throwaway database. */
export function createPersistence(options: PersistenceOptions = {}): Persistence {
  const url = new URL(options.databaseUrl ?? testDatabaseUrl());
  for (const [name, value] of Object.entries(options.urlParameters ?? {})) {
    url.searchParams.set(name, value);
  }
  const config = testAppConfig({ DATABASE_URL: url.toString(), ...options.env });
  const connectionWaitMs = options.connectionWaitMs ?? TEST_CONNECTION_WAIT_MS;
  const root = new PrismaRoot(config, { connectionWaitMs });
  const client = createGuardedClient(root, modelMap);
  return {
    root,
    client,
    service: new PrismaService(),
    unitOfWork: new PrismaUnitOfWork(client, modelMap, options.pause, connectionWaitMs),
    close: () => root.$disconnect(),
  };
}

export const marketOf = (code: string): MarketContext =>
  testMarketContext(code, PLATFORM_TENANT_ID);

/** The other Market fixture of ADR-0003 decision 9. */
export const otherMarketOf = (code: string): string => (code === 'AU' ? 'ZZ' : 'AU');

/** A valid `platform.audit_log` row. */
export function auditRow(market: MarketContext, overrides: Record<string, unknown> = {}) {
  return {
    id: randomUUID(),
    marketId: market.marketId as string,
    tenantId: market.tenantId as string,
    occurredAt: new Date('2026-10-07T00:00:00.000Z'),
    actorType: 'SYSTEM',
    action: 'platform.unit-of-work.tested',
    targetType: 'platform.unit-of-work',
    targetId: 'db-spec',
    correlationId: 'db-test-correlation-0001',
    ...overrides,
  };
}

/**
 * Records the SQL text every `pg` client of this test process sends while `during` runs.
 * Prisma's own query events show neither BEGIN nor SET TRANSACTION (the pg adapter sends
 * them itself), so the driver is where "no transaction" (ADR-0025) and "no SET TRANSACTION"
 * (decision 2) are observable. Jest runs each spec file in its own module registry, so the
 * patch reaches this file's pools only; `restore` undoes it.
 */
export function recordDriverStatements() {
  const statements: string[] = [];
  let recording = false;
  const prototype = PgClient.prototype as unknown as { query: (...args: unknown[]) => unknown };
  const original = prototype.query;
  prototype.query = function (this: unknown, ...args: unknown[]) {
    const [config] = args;
    if (recording) {
      statements.push(
        typeof config === 'string' ? config : ((config as { text?: string })?.text ?? ''),
      );
    }
    return original.apply(this, args);
  };
  return {
    statements,
    async during<T>(work: () => Promise<T>): Promise<T> {
      statements.length = 0;
      recording = true;
      try {
        return await work();
      } finally {
        recording = false;
      }
    },
    restore(): void {
      prototype.query = original;
    },
  };
}

/** A promise and its resolver: lets a test hold a unit open while it checks something. */
export function gate(): { readonly opened: Promise<void>; open(): void } {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { opened, open };
}

/**
 * Makes `unitOfWork` retry a refused attempt (`40001`) only once `released` has settled, or
 * after 5 s. A race test releases it when the other unit has settled: on a busy machine the
 * winner can take longer to commit than the short default pause, and a loser that retried
 * while the winner was still open would conflict again and use up its attempts. Returns the
 * restore.
 */
export function holdRetriesUntil(unitOfWork: unknown, released: Promise<unknown>): () => void {
  const unit = unitOfWork as { pause: RetryPause };
  const original = unit.pause;
  const settled = released.then(
    () => undefined,
    () => undefined,
  );
  unit.pause = async () => {
    await Promise.race([settled, new Promise((resolve) => setTimeout(resolve, 5000))]);
  };
  return () => {
    unit.pause = original;
  };
}

/**
 * Gives every unit `unitOfWork` runs a transaction timeout of `timeoutMs`. A race test holds each
 * unit open while it waits for the other to arrive; with Prisma's 5 s default a slow arrival
 * on a busy machine expires the held transaction and the next statement throws P2028, which is
 * no conflict and is not retried. Returns the restore.
 */
export function extendUnitTimeout(unitOfWork: unknown, timeoutMs: number): () => void {
  const unit = unitOfWork as {
    run: (
      market: MarketContext,
      work: unknown,
      options?: { readOnly?: boolean; timeoutMs?: number },
    ) => Promise<unknown>;
  };
  const original = unit.run;
  unit.run = function (market, work, options = {}) {
    // A read-only unit takes no timeout option (P 3.1 row 8).
    return original.call(
      this,
      market,
      work,
      options.readOnly ? options : { timeoutMs, ...options },
    );
  };
  return () => {
    unit.run = original;
  };
}

/** Milliseconds a promise took to settle, with its outcome. */
export async function timed<T>(
  promise: Promise<T>,
): Promise<{ ms: number; result?: T; error?: unknown }> {
  const start = process.hrtime.bigint();
  try {
    const result = await promise;
    return { ms: Number(process.hrtime.bigint() - start) / 1e6, result };
  } catch (error) {
    return { ms: Number(process.hrtime.bigint() - start) / 1e6, error };
  }
}

export { randomUUID };

/**
 * A use case whose `execute` is run again when the unit of work gives up on a serialization
 * conflict (`TransactionConflictError`). The platform retries a unit three times; under the
 * parallel database specs of one run, SERIALIZABLE units also meet false conflicts from other
 * files (predicate locks are page-wide on small tables), so three attempts can run out. A real
 * caller meets the same answer as `409 conflict.retry` or an event redelivery, and runs again;
 * this does the same for the specs that open serializable units. Only that error is retried.
 */
export function retryingConflicts<T extends { execute(...args: never[]): Promise<unknown> }>(
  useCase: T,
  attempts = 6,
): T {
  // A use case's `execute` is sealed on the instance, so the stand-in is a plain object that
  // carries only `execute`, which is all the specs call.
  return {
    execute: async (...args: never[]) => {
      for (let attempt = 1; ; attempt += 1) {
        try {
          return await useCase.execute(...args);
        } catch (error) {
          if (!(error instanceof TransactionConflictError) || attempt >= attempts) throw error;
        }
      }
    },
  } as unknown as T;
}
