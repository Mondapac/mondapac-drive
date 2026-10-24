import { Temporal } from '@mondapac-drive/shared-kernel';
import type { JobDefinition } from '../../../../platform/scheduler/job-registry';
import type { RunPayouts } from '../../application/use-cases/run-payouts.use-case';

/**
 * The payout job: every 15 minutes, in each hosted Market, open the run of a period that has
 * closed and send pending transfers. Safe to run twice and concurrently (RunPayouts). A broken
 * rule or a refused unit is thrown, so the scheduler logs the failed run and retries next tick.
 */
export function payoutJob(runPayouts: RunPayouts): JobDefinition {
  return {
    name: 'payouts.run-payouts',
    every: Temporal.Duration.from({ minutes: 15 }),
    maxRunMs: 300_000,
    run: async (context) => {
      const result = await runPayouts.run(context.market);
      if (!result.ok) throw new Error(`payouts.run-payouts refused: ${result.error.code}`);
    },
  };
}
