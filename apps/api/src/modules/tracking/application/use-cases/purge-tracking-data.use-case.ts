import { Inject, Injectable } from '@nestjs/common';
import type { Clock, MarketContext } from '@mondapac-drive/shared-kernel';
import { ok } from '@mondapac-drive/shared-kernel';
import { CLOCK } from '../../../../platform/clock/clock.module';
import { UNIT_OF_WORK, type UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { purgeCutoffs } from '../../domain/breadcrumb';
import {
  TRACKING_REPOSITORY,
  TRACKING_SETTINGS,
  type TrackingRepository,
  type TrackingSettingsProvider,
} from '../ports';

/** Rows of each kind one unit deletes. */
export const PURGE_BATCH = 1000;
/** Units one run may use per Market; the next run continues. */
export const MAX_PURGE_BATCHES = 50;

export interface PurgeOutcome {
  readonly breadcrumbs: number;
  readonly deliveries: number;
  readonly links: number;
}

/**
 * The retention job's use case (system): deletes the breadcrumbs older than the Market's
 * retention, the records of deliveries that ended before it, and expired links, in bounded
 * batches of one unit each. Safe to run twice and concurrently.
 */
@Injectable()
export class PurgeTrackingData {
  constructor(
    @Inject(TRACKING_REPOSITORY) private readonly tracking: TrackingRepository,
    @Inject(TRACKING_SETTINGS) private readonly settings: TrackingSettingsProvider,
    @Inject(UNIT_OF_WORK) private readonly unitOfWork: UnitOfWork,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async perform(market: MarketContext): Promise<PurgeOutcome> {
    const cutoffs = purgeCutoffs(this.settings.get(market.marketId), this.clock.now());
    const total = { breadcrumbs: 0, deliveries: 0, links: 0 };
    for (let batch = 0; batch < MAX_PURGE_BATCHES; batch += 1) {
      const done = await this.unitOfWork.run(market, async () =>
        ok(await this.tracking.purge(market, cutoffs, PURGE_BATCH)),
      );
      if (!done.ok) break;
      total.breadcrumbs += done.value.breadcrumbs;
      total.deliveries += done.value.deliveries;
      total.links += done.value.links;
      const full = Math.max(done.value.breadcrumbs, done.value.deliveries, done.value.links);
      if (full < PURGE_BATCH) break;
    }
    return total;
  }
}
