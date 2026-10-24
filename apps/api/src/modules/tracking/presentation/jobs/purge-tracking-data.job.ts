import { Logger } from '@nestjs/common';
import { Temporal } from '@mondapac-drive/shared-kernel';
import type { JobDefinition } from '../../../../platform/scheduler/job-registry';
import type { PurgeTrackingData } from '../../application/use-cases/purge-tracking-data.use-case';

const logger = new Logger('tracking.purge-expired');

/**
 * Retention of live-location personal data: every hour, per Market, the breadcrumbs past the
 * Market's `breadcrumbRetentionDays`, the records of deliveries that ended before then, and
 * expired tracking links. Logs counts only.
 */
export function purgeTrackingDataJob(purge: PurgeTrackingData): JobDefinition {
  return {
    name: 'tracking.purge-expired',
    every: Temporal.Duration.from({ hours: 1 }),
    maxRunMs: 300_000,
    async run(context) {
      const outcome = await purge.perform(context.market);
      if (outcome.breadcrumbs + outcome.deliveries + outcome.links > 0) {
        logger.log({ msg: 'tracking.purged', marketId: context.market.marketId, ...outcome });
      }
    },
  };
}
