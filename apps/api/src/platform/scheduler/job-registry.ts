import {
  Injectable,
  type InjectionToken,
  type OnApplicationBootstrap,
  type Provider,
} from '@nestjs/common';
import { Temporal } from '@mondapac-drive/shared-kernel';
import type { CallContext, SystemActor } from '@mondapac-drive/shared-kernel';
import { jobLockKey, PRISMA_MIGRATE_LOCK_KEY } from './job-lock';

/**
 * What a job run receives for one Market (platform persistence design, "P", 7; foundations
 * 5.1): a minted `CallContext` of that Market, its system actor and a newly generated
 * correlation id, built by the scheduler through `createCallContext`. The type requires the
 * system actor, so a job always has the context a `system` use case needs and never builds one
 * itself (security review of slice 1b, I3); the context is passed to the use case unchanged.
 */
export type JobContext = CallContext & { readonly actor: SystemActor };

/**
 * A scheduled job (P 7). Declared in the owning module's `presentation/jobs/`, registered
 * with {@link registerJobs}. `run` calls one use case whose access rule is `system`; it must
 * be safe to run twice and concurrently, and works in bounded batches, one unit each.
 */
export interface JobDefinition {
  /** `<module>.<job>`. */
  readonly name: string;
  /** A fixed interval; no cron, no wall-clock time. */
  readonly every: Temporal.Duration;
  /**
   * Default {@link DEFAULT_MAX_RUN_MS}, at most {@link MAX_RUN_MS}. It bounds the lock, not
   * the work: at `maxRunMs` the lock transaction ends and the lock is released, but `run` is
   * not cancelled (there is no AbortSignal yet) and may keep running while the next tick, on
   * this or another process, takes the lock and starts the job again. So every job must be
   * idempotent and safe to overlap with a late run of itself (P 7): each batch in its own
   * unit, conditional updates, no step that assumes it still holds the lock.
   */
  readonly maxRunMs?: number;
  /**
   * Whether the first tick runs as soon as the worker starts instead of after a random part of
   * the interval: for a job that brings a Market's state up to date at worker start, such as a
   * seed (identity design 5.6). Default false.
   */
  readonly runAtStart?: boolean;
  /** May outlive the lock after `maxRunMs` (see there); must be idempotent (P 7). */
  run(context: JobContext): Promise<void>;
}

export const DEFAULT_MAX_RUN_MS = 60_000;
export const MAX_RUN_MS = 600_000;
/** The shortest interval a job may declare. */
export const MIN_INTERVAL_MS = 1000;

const JOB_NAME = /^([a-z][a-z0-9-]*)\.[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Registration refused at boot (P 7). */
export class JobRegistryError extends Error {
  override readonly name = 'JobRegistryError';
}

/** A job's interval in milliseconds; `every` has no calendar unit. */
export function intervalMsOf(job: Pick<JobDefinition, 'every'>): number {
  const { years, months, weeks } = job.every;
  if (years !== 0 || months !== 0 || weeks !== 0) {
    throw new JobRegistryError('A job interval is in days, hours, minutes or seconds only');
  }
  return job.every.total({ unit: 'milliseconds' });
}

/**
 * Every job of the application (P 7). Modules register at bootstrap: the first segment of a
 * name is the registering module, a duplicate fails boot, and the registry is sealed when the
 * application has bootstrapped, the same in both roles (P 8).
 */
@Injectable()
export class JobRegistry implements OnApplicationBootstrap {
  readonly #jobs = new Map<string, JobDefinition>();
  #sealed = false;

  register(module: string, jobs: readonly JobDefinition[]): void {
    if (this.#sealed) throw new JobRegistryError('The job registry is sealed');
    for (const job of jobs) {
      const name = JOB_NAME.exec(job.name);
      if (name === null || name[1] !== module) {
        throw new JobRegistryError(`Module "${module}" cannot register the job "${job.name}"`);
      }
      if (jobLockKey(job.name) === PRISMA_MIGRATE_LOCK_KEY) {
        // PM8: the lock key must never be the one Prisma Migrate holds.
        throw new JobRegistryError(`The job "${job.name}" has the lock key of Prisma Migrate`);
      }
      if (this.#jobs.has(job.name)) {
        throw new JobRegistryError(`The job "${job.name}" is registered twice`);
      }
      if (!(job.every instanceof Temporal.Duration) || intervalMsOf(job) < MIN_INTERVAL_MS) {
        throw new JobRegistryError(`The job "${job.name}" needs an interval of at least 1 s`);
      }
      const maxRunMs = job.maxRunMs ?? DEFAULT_MAX_RUN_MS;
      if (!Number.isInteger(maxRunMs) || maxRunMs < 1 || maxRunMs > MAX_RUN_MS) {
        throw new JobRegistryError(`The job "${job.name}" has a maxRunMs outside 1 to 600000`);
      }
      this.#jobs.set(job.name, job);
    }
  }

  seal(): void {
    this.#sealed = true;
  }

  onApplicationBootstrap(): void {
    this.seal();
  }

  get(name: string): JobDefinition | undefined {
    return this.#jobs.get(name);
  }

  /** The names of every job, sorted. */
  names(): string[] {
    return [...this.#jobs.keys()].sort();
  }
}

/**
 * The one line of a module's Nest module that registers its jobs:
 * `providers: [registerJobs('identity', [purgeExpired])]`.
 */
export function registerJobs(module: string, jobs: readonly JobDefinition[]): Provider {
  return {
    provide: Symbol(`jobs:${module}`),
    inject: [JobRegistry],
    useFactory: (registry: JobRegistry) => {
      registry.register(module, jobs);
      return module;
    },
  };
}

/**
 * As {@link registerJobs}, for jobs that need providers of their module (a use case): `build`
 * receives the providers named in `inject`, in order, and returns the module's jobs.
 * `providers: [registerJobsFrom('identity', [PurgeExpired], (purge) => [purgeExpiredJob(purge)])]`.
 */
export function registerJobsFrom(
  module: string,
  inject: readonly InjectionToken[],
  build: (...dependencies: never[]) => readonly JobDefinition[],
): Provider {
  return {
    provide: Symbol(`jobs:${module}`),
    inject: [JobRegistry, ...inject],
    useFactory: (registry: JobRegistry, ...dependencies: never[]) => {
      registry.register(module, build(...dependencies));
      return module;
    },
  };
}
