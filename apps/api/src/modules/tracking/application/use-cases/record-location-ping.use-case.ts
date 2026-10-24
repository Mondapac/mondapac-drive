import { Inject, Injectable } from '@nestjs/common';
import {
  err,
  ok,
  type Clock,
  type MarketContext,
  type Result,
  type Temporal,
} from '@mondapac-drive/shared-kernel';
import { CLOCK } from '../../../../platform/clock/clock.module';
import { UNIT_OF_WORK, type UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import type { Breadcrumb } from '../../domain/breadcrumb';
import { livePositionOf } from '../../domain/live-position';
import { checkPing, type LocationPing } from '../../domain/location-ping';
import { recordsTrail } from '../../domain/tracked-delivery';
import { failure, type TrackingFailure } from '../failure';
import {
  LIVE_POSITION_STORE,
  TRACKING_REPOSITORY,
  TRACKING_SETTINGS,
  type LivePositionStore,
  type TrackingRepository,
  type TrackingSettingsProvider,
} from '../ports';

export interface LocationPingInput {
  readonly courierId: string;
  readonly lat: number;
  readonly lng: number;
  readonly accuracyM: number;
  readonly headingDeg?: number;
  readonly speedKmh?: number;
  readonly recordedAt: Temporal.Instant;
  readonly serviceArea?: string;
}

export interface PingOutcome {
  /** False when a later reading of the courier was already stored. */
  readonly latest: boolean;
  /** How many active deliveries the ping added a breadcrumb to. */
  readonly breadcrumbs: number;
}

/**
 * A courier's device reports where it is. The ping is checked against the Market's rules,
 * throttled per courier, saved as the courier's live position, and added to the trail of every
 * delivery the courier is carrying. Coordinates never reach a log or a refusal.
 */
@Injectable()
export class RecordLocationPing {
  constructor(
    @Inject(LIVE_POSITION_STORE) private readonly positions: LivePositionStore,
    @Inject(TRACKING_REPOSITORY) private readonly tracking: TrackingRepository,
    @Inject(TRACKING_SETTINGS) private readonly settings: TrackingSettingsProvider,
    @Inject(UNIT_OF_WORK) private readonly unitOfWork: UnitOfWork,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async perform(
    market: MarketContext,
    input: LocationPingInput,
  ): Promise<Result<PingOutcome, TrackingFailure>> {
    const settings = this.settings.get(market.marketId);
    // checkPing refuses coordinates off the globe before the point is used.
    const point = { lat: input.lat, lng: input.lng };
    const ping: LocationPing = {
      courierId: input.courierId,
      point,
      accuracyMetres: input.accuracyM,
      ...(input.headingDeg === undefined ? {} : { headingDegrees: input.headingDeg }),
      ...(input.speedKmh === undefined ? {} : { speedKmh: input.speedKmh }),
      recordedAt: input.recordedAt,
      ...(input.serviceArea === undefined ? {} : { serviceAreaCode: input.serviceArea }),
    };
    const checked = checkPing(settings, ping, this.clock.now());
    if (!checked.ok) {
      const refusal = checked.error;
      return err(
        refusal.code === 'ping.invalid'
          ? failure(refusal.code, 'The ping is not valid', { field: refusal.field })
          : refusal.code === 'ping.stale'
            ? failure(refusal.code, 'The ping was recorded too long ago')
            : failure(refusal.code, 'The ping was recorded in the future'),
      );
    }

    const interval = settings.ping.minIntervalSeconds;
    if (!(await this.positions.claimPingSlot(market.marketId, ping.courierId, interval))) {
      return err(
        failure('ping.throttled', 'The courier sent a ping too recently', {
          retryAfterSeconds: interval,
        }),
      );
    }
    const latest = await this.positions.save(
      market.marketId,
      livePositionOf(ping),
      settings.livePositionTtlSeconds,
    );

    return this.unitOfWork.run(market, async () => {
      const carried = await this.tracking.activeDeliveriesOf(market, ping.courierId);
      const breadcrumbs: Breadcrumb[] = carried
        .filter((delivery) => recordsTrail(delivery, ping.courierId))
        .map((delivery) => ({
          deliveryId: delivery.deliveryId,
          courierId: ping.courierId,
          point: ping.point,
          accuracyMetres: ping.accuracyMetres,
          recordedAt: ping.recordedAt,
        }));
      if (breadcrumbs.length > 0) await this.tracking.appendBreadcrumbs(market, breadcrumbs);
      return ok({ latest, breadcrumbs: breadcrumbs.length });
    });
  }
}
