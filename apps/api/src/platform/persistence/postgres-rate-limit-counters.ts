import type { OnModuleDestroy } from '@nestjs/common';
import type { Clock } from '@mondapac-drive/shared-kernel';
import { RateLimiterPostgres } from 'rate-limiter-flexible';
import { RATE_LIMIT_CLASSES } from '../rate-limit/rate-limit.decorator';
import {
  SUBJECT_LIMIT_WINDOWS,
  windowSecondsOf,
  type CountedClass,
  type RateLimitCount,
  type RateLimitCounters,
  type SubjectLimitClass,
} from '../rate-limit/rate-limit-counters';
import type { PrismaRoot } from './prisma-root';

/** The counter table (migration 20261019211148_platform_rate_limit_counters). */
export const RATE_LIMIT_SCHEMA = 'platform';
export const RATE_LIMIT_TABLE = 'rate_limit_counters';

/** How often this process deletes the windows that ended over an hour ago (the package's own pace). */
export const RATE_LIMIT_PURGE_EVERY_MS = 5 * 60_000;
const PURGE_AFTER_MS = 60 * 60_000;

/** What the package's PostgreSQL store sends to its client. */
interface StoreQuery {
  readonly name?: string;
  readonly text: string;
  readonly values?: readonly unknown[];
}

/**
 * {@link RateLimitCounters} on the PostgreSQL store of `rate-limiter-flexible` (identity design
 * 13; owner-approved package, pinned 11.2.1). One row per limit class and key (origin or subject) in
 * `platform.rate_limit_counters`, counted by the package's single `INSERT ... ON CONFLICT DO
 * UPDATE`, so concurrent requests on any number of API instances add to one count.
 *
 * The store talks to the process's pool through the base client, outside any unit of work (the
 * table has no Market: PF I11). Its statement `name` is dropped, because the application never
 * uses named prepared statements (data platform.md 10.9), and `bigint` columns come back as
 * numbers, as the package expects from `pg`. The table is created by the migration, never by
 * the package (`tableCreated`), so the application role needs no CREATE.
 */
export class PostgresRateLimitCounters implements RateLimitCounters, OnModuleDestroy {
  readonly #limiters: Readonly<Record<CountedClass, RateLimiterPostgres>>;
  readonly #purge: NodeJS.Timeout;

  constructor(
    private readonly root: PrismaRoot,
    clock: Clock,
  ) {
    const storeClient = {
      query: async ({ text, values }: StoreQuery) => {
        const rows = await root.$queryRawUnsafe<Record<string, unknown>[]>(text, ...(values ?? []));
        return { rows: rows.map(numbersOf), rowCount: rows.length };
      },
    };
    const limiters = {} as Record<CountedClass, RateLimiterPostgres>;
    const counted: readonly CountedClass[] = [
      ...RATE_LIMIT_CLASSES,
      ...(Object.keys(SUBJECT_LIMIT_WINDOWS) as SubjectLimitClass[]),
    ];
    for (const limitClass of counted) {
      // The library never refuses (the limit is the Market's, compared by the guard), so one
      // counter serves every Market: `points` is only the ceiling of the count it keeps.
      limiters[limitClass] = new RateLimiterPostgres({
        storeClient,
        storeType: 'client',
        schemaName: RATE_LIMIT_SCHEMA,
        tableName: RATE_LIMIT_TABLE,
        tableCreated: true,
        clearExpiredByTimeout: false,
        keyPrefix: limitClass,
        points: Number.MAX_SAFE_INTEGER,
        duration: windowSecondsOf(limitClass),
      });
    }
    this.#limiters = Object.freeze(limiters);
    // The package's purge (windows that ended over an hour ago, every 5 minutes), on a timer this
    // class can stop. Every instance runs it, which is harmless: it deletes rows nobody counts
    // in any more. A failed purge is not critical and is retried at the next tick.
    // The package sets `expire` from the wall clock; the injected Clock is the wall clock in
    // production, so the cut-off and the windows agree (data platform.md section 12).
    this.#purge = setInterval(() => {
      this.purgeEnded(clock.now().epochMilliseconds - PURGE_AFTER_MS).catch(() => undefined);
    }, RATE_LIMIT_PURGE_EVERY_MS);
    this.#purge.unref();
  }

  async consume(limitClass: CountedClass, key: string): Promise<RateLimitCount> {
    const counted = await this.#limiters[limitClass].consume(key);
    return { count: counted.consumedPoints, msBeforeNext: counted.msBeforeNext };
  }

  /** Deletes the windows that ended before `before` (epoch milliseconds); answers how many. */
  async purgeEnded(before: number): Promise<number> {
    return await this.root.$executeRaw`
      DELETE FROM "platform"."rate_limit_counters" WHERE "expire" < ${before}`;
  }

  onModuleDestroy(): void {
    clearInterval(this.#purge);
  }
}

/** A row with its `bigint` values as numbers (epoch milliseconds fit exactly). */
function numbersOf(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(row).map(([column, value]) => [
      column,
      typeof value === 'bigint' ? Number(value) : value,
    ]),
  );
}
