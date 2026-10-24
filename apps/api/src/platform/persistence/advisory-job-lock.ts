import type { JobLock, JobLockOutcome } from '../scheduler/job-lock';
import { CONNECTION_WAIT_MS } from '../unit-of-work/unit-of-work';
import type { PrismaRoot } from './prisma-root';

/**
 * The scheduler's lock (platform persistence design, "P", 7; PA3): a transaction of its own on
 * the base client holds `pg_try_advisory_xact_lock(key)` for the whole run and ends at
 * `maxRunMs` (Prisma's transaction timeout) or with a lost connection. The transaction-scoped
 * form, because the pool gives no session affinity outside a transaction.
 *
 * The holder is idle in its transaction while the job works in units of its own, so it first
 * sets `idle_in_transaction_session_timeout` to 0 for this transaction only (`SET LOCAL`): the
 * login role's 60 s limit (PK1) would otherwise end it (Ali, F2). Nothing else is changed, and
 * the setting ends with the transaction.
 */
export class AdvisoryJobLock implements JobLock {
  constructor(private readonly root: PrismaRoot) {}

  async runExclusive(
    key: bigint,
    maxRunMs: number,
    work: () => Promise<void>,
  ): Promise<JobLockOutcome> {
    return this.root.$transaction(
      async (transaction) => {
        await transaction.$executeRawUnsafe('SET LOCAL idle_in_transaction_session_timeout = 0');
        const rows = await transaction.$queryRaw<{ locked: boolean }[]>`
          SELECT pg_try_advisory_xact_lock(${key}) AS locked`;
        if (rows[0]?.locked !== true) return 'skipped';
        await work();
        return 'ran';
      },
      { maxWait: CONNECTION_WAIT_MS, timeout: maxRunMs },
    );
  }
}
