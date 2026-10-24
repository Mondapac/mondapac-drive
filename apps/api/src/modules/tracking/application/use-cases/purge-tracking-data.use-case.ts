import { err, ok, type CallContext, type Clock, type Result } from '@mondapac-drive/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { purgeCutoffs } from '../../domain/breadcrumb';
import { ACCESS_DENIED, isSystem } from '../callers';
import type { TrackingFailure } from '../failure';
import type { TrackingRepository, TrackingSettingsProvider } from '../ports';

/** Rows of each kind one unit deletes. */
export const PURGE_BATCH = 1000;
/** Units one run may use per Market; the next run continues. */
export const MAX_PURGE_BATCHES = 50;

export interface PurgeOutcome {
  readonly breadcrumbs: number;
  readonly deliveries: number;
  readonly links: number;
}

export interface PurgeTrackingDataDependencies {
  readonly tracking: TrackingRepository;
  readonly settings: TrackingSettingsProvider;
  readonly unitOfWork: UnitOfWork;
  readonly clock: Clock;
}

/**
 * The retention job's use case: deletes the breadcrumbs older than the Market's retention, the
 * records of deliveries that ended before it, and expired links, in bounded batches of one unit
 * each. Safe to run twice and concurrently. Rule `system`: run by the hourly job only.
 */
export class PurgeTrackingData extends UseCase<
  Record<string, never>,
  PurgeOutcome,
  TrackingFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'tracking.purge-expired',
    rule: { kind: 'system' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: PurgeTrackingDataDependencies,
  ) {
    super(gate);
  }

  protected async handle(context: CallContext): Promise<Result<PurgeOutcome, TrackingFailure>> {
    if (!isSystem(context)) return err(ACCESS_DENIED);
    const { market } = context;
    const { tracking, settings, unitOfWork, clock } = this.deps;
    const cutoffs = purgeCutoffs(settings.get(market.marketId), clock.now());
    const total = { breadcrumbs: 0, deliveries: 0, links: 0 };
    for (let batch = 0; batch < MAX_PURGE_BATCHES; batch += 1) {
      const done = await unitOfWork.run(market, async () =>
        ok(await tracking.purge(market, cutoffs, PURGE_BATCH)),
      );
      if (!done.ok) break;
      total.breadcrumbs += done.value.breadcrumbs;
      total.deliveries += done.value.deliveries;
      total.links += done.value.links;
      const full = Math.max(done.value.breadcrumbs, done.value.deliveries, done.value.links);
      if (full < PURGE_BATCH) break;
    }
    return ok(total);
  }
}
