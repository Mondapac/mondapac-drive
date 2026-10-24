import { Logger } from '@nestjs/common';
import { parseCorrelationId } from '@mondapac-drive/shared-kernel';
import type { IdGenerator } from '@mondapac-drive/shared-kernel';
import { createCallContext, systemActor } from '@mondapac-drive/shared-kernel/contexts';
import type { MarketRegistry } from '../market-config/market-registry';
import type { MarketContextFactory } from '../market-context/market-context.factory';
import { jobLockKey, type JobLock, type JobLockOutcome } from './job-lock';
import {
  DEFAULT_MAX_RUN_MS,
  intervalMsOf,
  type JobContext,
  type JobDefinition,
  type JobRegistry,
} from './job-registry';

/** Unknown job name given to {@link Scheduler.runJobOnce}. */
export class UnknownJobError extends Error {
  override readonly name = 'UnknownJobError';
  constructor() {
    super('No job of that name is registered');
  }
}

/** What one run did: skipped when another runner held the lock, else the Markets that failed. */
export type JobRunResult =
  { readonly outcome: 'skipped' } | { readonly outcome: 'ran'; readonly failedMarkets: string[] };

/** Where the first tick of a job falls inside its interval: a fraction from 0 to 1. */
export type Jitter = () => number;

/**
 * The scheduler runner of platform persistence design, "P", 7, for the `worker` role. Each job
 * ticks every `every`, the first time after a random part of the interval, or at once for a
 * job declared `runAtStart`. A run takes the
 * job's lock (one runner across processes, skipped when taken) and then, for each hosted
 * Market in turn: the Market's context from the factory, a newly generated correlation id, and
 * `run(context)`. One Market's failure is logged with job, Market and correlation id, and the
 * next Market still runs (foundations 5.1). No schedule state is stored.
 *
 * Nothing starts on construction: `WorkerRuntime.start()` calls {@link start}, and tests call
 * {@link runJobOnce} themselves (P 8).
 */
export class Scheduler {
  private readonly logger = new Logger('Scheduler');
  private readonly timers = new Set<NodeJS.Timeout>();
  private readonly inFlight = new Set<Promise<unknown>>();
  private stopping = false;

  constructor(
    private readonly registry: JobRegistry,
    private readonly lock: JobLock,
    private readonly markets: MarketRegistry,
    private readonly contexts: MarketContextFactory,
    private readonly ids: IdGenerator,
    private readonly jitter: Jitter = Math.random,
  ) {}

  async runJobOnce(name: string): Promise<JobRunResult> {
    const job = this.registry.get(name);
    if (job === undefined) throw new UnknownJobError();
    const failedMarkets: string[] = [];
    const outcome: JobLockOutcome = await this.lock.runExclusive(
      jobLockKey(job.name),
      job.maxRunMs ?? DEFAULT_MAX_RUN_MS,
      async () => {
        for (const marketId of this.markets.hostedMarketIds()) {
          if (!(await this.runForMarket(job, marketId))) failedMarkets.push(marketId);
        }
      },
    );
    return outcome === 'skipped' ? { outcome } : { outcome, failedMarkets };
  }

  private async runForMarket(job: JobDefinition, marketId: string): Promise<boolean> {
    const market = this.contexts.forMarket(marketId);
    const correlationId = parseCorrelationId(this.ids.next<'job-run'>());
    if (!market.ok || !correlationId.ok) {
      this.logger.error({ msg: 'job.market-skipped', job: job.name, marketId });
      return false;
    }
    try {
      // The job's CallContext: this Market's system actor (foundations 5.1; P 7).
      const context: JobContext = createCallContext(
        market.value,
        systemActor(market.value),
        correlationId.value,
      );
      await job.run(context);
      return true;
    } catch (error) {
      this.logger.error({
        msg: 'job.failed',
        job: job.name,
        marketId,
        correlationId: correlationId.value,
        err: error,
      });
      return false;
    }
  }

  /** Starts a timer per registered job. Called by `WorkerRuntime.start()` only. */
  start(): void {
    this.stopping = false;
    for (const name of this.registry.names()) {
      const job = this.registry.get(name)!;
      const interval = intervalMsOf(job);
      const first = setTimeout(
        () => {
          this.timers.delete(first);
          this.tick(name);
          const every = setInterval(() => this.tick(name), interval);
          this.timers.add(every);
        },
        job.runAtStart === true ? 0 : Math.floor(this.jitter() * interval),
      );
      this.timers.add(first);
    }
  }

  private tick(name: string): void {
    if (this.stopping) return;
    const run = this.runJobOnce(name)
      .then((result) => {
        if (result.outcome === 'skipped') {
          this.logger.debug({ msg: 'job.skipped', job: name });
        }
      })
      .catch((error: unknown) => {
        // The lock transaction failed or ended at maxRunMs; the next tick picks the work up.
        this.logger.error({ msg: 'job.run-failed', job: name, err: error });
      })
      .finally(() => this.inFlight.delete(run));
    this.inFlight.add(run);
  }

  /** No new tick; waits up to `graceMs` for the runs in flight (P 8). */
  async stop(graceMs: number): Promise<void> {
    this.stopping = true;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    let timeout: NodeJS.Timeout | undefined;
    const grace = new Promise<void>((resolve) => {
      timeout = setTimeout(resolve, graceMs);
    });
    await Promise.race([Promise.allSettled([...this.inFlight]), grace]);
    clearTimeout(timeout);
  }
}
