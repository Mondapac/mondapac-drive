import { Logger } from '@nestjs/common';
import { Temporal } from '@mondapac-drive/shared-kernel';
import type { JobContext, JobDefinition } from '../../../../platform/scheduler/job-registry';
import type { SeedRoles } from '../../application/use-cases/seed-roles.use-case';

/** The job's name (identity design 5.6). */
export const SEED_ROLES_JOB = 'identity.seed-roles';

/**
 * `identity.seed-roles` (identity design 5.6; slices 5 and 8a-1): the seed routine per hosted
 * Market, at worker start (`runAtStart`) and then daily, through `SeedRoles` (rule `system`). It
 * creates missing system and default roles and applies a newer seed version, each with its audit
 * row. Safe to run twice and concurrently. A refusal throws, so the scheduler logs that Market's
 * run as failed and continues with the next.
 */
export function seedRolesJob(seed: SeedRoles): JobDefinition {
  const logger = new Logger('SeedRolesJob');
  return {
    name: SEED_ROLES_JOB,
    every: Temporal.Duration.from({ hours: 24 }),
    runAtStart: true,
    async run(context: JobContext): Promise<void> {
      const result = await seed.execute(context, {});
      if (!result.ok) throw new Error(`${SEED_ROLES_JOB} refused: ${result.error.code}`);
      logger.log({
        msg: SEED_ROLES_JOB,
        marketId: context.market.marketId,
        correlationId: context.correlationId,
        ...result.value,
      });
    },
  };
}
