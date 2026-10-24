import { createHash } from 'node:crypto';

/** Whether a run held the lock and ran, or found it taken and skipped the tick. */
export type JobLockOutcome = 'ran' | 'skipped';

/**
 * One runner per job across processes (platform persistence design, "P", 7; ADR-0006
 * decision 7). Implemented in `platform/persistence/` with a transaction-scoped advisory lock.
 * The lock saves cost and noise; it is not a correctness control: every job is safe to run
 * twice and concurrently.
 */
export interface JobLock {
  runExclusive(key: bigint, maxRunMs: number, work: () => Promise<void>): Promise<JobLockOutcome>;
}

/** Nest token of the {@link JobLock}. */
export const JOB_LOCK = Symbol('JOB_LOCK');

/**
 * The lock key of a job (P 7; PM8): the first 8 bytes of SHA-256 over `mondapac.job:<name>`,
 * as a signed 64-bit integer.
 */
export function jobLockKey(name: string): bigint {
  return createHash('sha256').update(`mondapac.job:${name}`, 'utf8').digest().readBigInt64BE(0);
}

/** The session advisory lock key Prisma Migrate holds (data design 10); no job may use it. */
export const PRISMA_MIGRATE_LOCK_KEY = 72707369n;
