import { Logger } from '@nestjs/common';
import { Temporal } from '@mondapac-drive/shared-kernel';
import type { JobDefinition } from '../../../../platform/scheduler/job-registry';
import type { SweepDocumentFiles } from '../../application/use-cases/sweep-document-files.use-case';

const logger = new Logger('fleet.sweep-document-files');

/**
 * Every six hours, per Market, removes stored courier document files that no document row names
 * (personal data that would otherwise stay in storage). Runs as the Market's system actor; logs
 * counts only, never a key.
 */
export function sweepDocumentFilesJob(sweep: SweepDocumentFiles): JobDefinition {
  return {
    name: 'fleet.sweep-document-files',
    every: Temporal.Duration.from({ hours: 6 }),
    maxRunMs: 300_000,
    async run(context) {
      const result = await sweep.execute(context, {});
      if (!result.ok) throw new Error(`fleet.sweep-document-files refused: ${result.error.code}`);
      if (result.value.removed > 0) {
        logger.log({
          msg: 'fleet.files-swept',
          marketId: context.market.marketId,
          ...result.value,
        });
      }
    },
  };
}
