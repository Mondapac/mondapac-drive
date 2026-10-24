import { Temporal } from '@mondapac-drive/shared-kernel';
import type { JobDefinition } from '../../../../platform/scheduler/job-registry';
import type { AdvanceDispatchJobs } from '../../application/use-cases/advance-dispatch-jobs.use-case';

/**
 * Every five seconds, per Market: opens scheduled jobs whose time has come, expires offers past
 * their accept timeout and sends the next wave. An offer therefore lapses at most one interval
 * after its timeout.
 */
export function advanceDispatchJobsJob(advance: AdvanceDispatchJobs): JobDefinition {
  return {
    name: 'dispatch.advance-jobs',
    every: Temporal.Duration.from({ seconds: 5 }),
    maxRunMs: 30_000,
    run: async (context) => {
      const swept = await advance.execute(context, {});
      if (!swept.ok) throw new Error(`dispatch.advance-jobs refused: ${swept.error.code}`);
    },
  };
}
