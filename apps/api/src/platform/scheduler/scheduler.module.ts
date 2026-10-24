import { Global, Module } from '@nestjs/common';
import type { IdGenerator } from '@mondapac-drive/shared-kernel';
import { ID_GENERATOR } from '../ids/ids.module';
import { MarketRegistry } from '../market-config/market-registry';
import { MarketContextFactory } from '../market-context/market-context.factory';
import { JOB_LOCK, type JobLock } from './job-lock';
import { JobRegistry } from './job-registry';
import { Scheduler } from './scheduler';

/**
 * The scheduler (platform persistence design, "P", 7): the job registry modules register
 * with, and the runner the worker starts. The lock is bound by the persistence module.
 */
@Global()
@Module({
  providers: [
    JobRegistry,
    {
      provide: Scheduler,
      inject: [JobRegistry, JOB_LOCK, MarketRegistry, MarketContextFactory, ID_GENERATOR],
      useFactory: (
        registry: JobRegistry,
        lock: JobLock,
        markets: MarketRegistry,
        contexts: MarketContextFactory,
        ids: IdGenerator,
      ) => new Scheduler(registry, lock, markets, contexts, ids),
    },
  ],
  exports: [JobRegistry, Scheduler],
})
export class SchedulerModule {}
