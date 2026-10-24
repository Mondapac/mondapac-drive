import { Inject, Injectable } from '@nestjs/common';
import {
  err,
  ok,
  type Clock,
  type MarketContext,
  type Result,
} from '@mondapac-drive/shared-kernel';
import { CLOCK } from '../../../../platform/clock/clock.module';
import { UNIT_OF_WORK, type UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import {
  phaseOf,
  showsCourierToCustomer,
  type TrackedDelivery,
} from '../../domain/tracked-delivery';
import {
  checkLinkOpen,
  customerView,
  mayShowCourierPosition,
  type CustomerView,
} from '../../domain/tracking-link';
import { failure, type TrackingFailure } from '../failure';

/** The refusals of every tracking use case, for the entry points that map them. */
export type { TrackingFailure };
import {
  ETA_PROVIDER,
  LIVE_POSITION_STORE,
  TRACKING_REPOSITORY,
  TRACKING_SETTINGS,
  TRACKING_TOKENS,
  type EtaProvider,
  type LivePositionStore,
  type TrackingRepository,
  type TrackingSettingsProvider,
  type TrackingTokens,
} from '../ports';

const MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  'tracking.link-not-found': 'No such tracking link',
  'tracking.link-expired': 'The tracking link has expired',
  'tracking.ended': 'The delivery has ended',
});

/**
 * What a customer's tracking link shows (no login: the token is the only credential). An unknown
 * or malformed token, an expired link and an ended delivery answer a refusal and nothing else.
 */
@Injectable()
export class ViewTrackingLink {
  constructor(
    @Inject(TRACKING_REPOSITORY) private readonly tracking: TrackingRepository,
    @Inject(TRACKING_TOKENS) private readonly tokens: TrackingTokens,
    @Inject(LIVE_POSITION_STORE) private readonly positions: LivePositionStore,
    @Inject(ETA_PROVIDER) private readonly eta: EtaProvider,
    @Inject(TRACKING_SETTINGS) private readonly settings: TrackingSettingsProvider,
    @Inject(UNIT_OF_WORK) private readonly unitOfWork: UnitOfWork,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** How often the tracking page's live channel sends a new view (Market setting). */
  refreshIntervalSeconds(market: MarketContext): number {
    return this.settings.get(market.marketId).streamIntervalSeconds;
  }

  async perform(
    market: MarketContext,
    token: string,
  ): Promise<Result<CustomerView, TrackingFailure>> {
    const hash = this.tokens.hashOf(token);
    if (hash === undefined) return refused('tracking.link-not-found');
    const found = await this.unitOfWork.run(
      market,
      async (): Promise<Result<{ delivery: TrackedDelivery; showPosition: boolean }, string>> => {
        const link = await this.tracking.findLink(market, hash);
        if (link === undefined) return err('tracking.link-not-found');
        const open = checkLinkOpen(link, this.clock.now());
        if (!open.ok) return err(open.error.code);
        const delivery = await this.tracking.findDelivery(market, link.deliveryId);
        if (delivery === undefined) return err('tracking.link-not-found');
        const carried =
          delivery.courierId === undefined
            ? []
            : await this.tracking.activeDeliveriesOf(market, delivery.courierId);
        return ok({ delivery, showPosition: mayShowCourierPosition(delivery, carried) });
      },
      { readOnly: true },
    );
    if (!found.ok) return refused(found.error);
    const { delivery, showPosition } = found.value;

    // The courier's position and the ETA are read only while the customer may see them.
    let courier;
    let etaSeconds;
    if (showsCourierToCustomer(phaseOf(delivery.status)) && delivery.courierId !== undefined) {
      courier = await this.positions.lastKnown(market.marketId, delivery.courierId);
      if (courier !== undefined && delivery.vehicle !== undefined) {
        etaSeconds = await this.eta.etaSeconds(
          market,
          courier.point,
          delivery.dropoff,
          delivery.vehicle,
        );
      }
    }
    const view = customerView(delivery, courier, etaSeconds, showPosition);
    return view.ok ? ok(view.value) : refused(view.error.code);
  }
}

function refused(code: string): Result<never, TrackingFailure> {
  return err(failure(code, MESSAGES[code] ?? 'Tracking is not available'));
}
