import { Inject, Injectable } from '@nestjs/common';
import {
  err,
  ok,
  type Clock,
  type Id,
  type MarketContext,
  type Result,
  type Temporal,
} from '@mondapac-drive/shared-kernel';
import { CLOCK } from '../../../../platform/clock/clock.module';
import { UNIT_OF_WORK, type UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { issueTrackingLink } from '../../domain/tracking-link';
import { deliveryNotTracked, failure, type TrackingFailure } from '../failure';
import {
  TRACKING_REPOSITORY,
  TRACKING_SETTINGS,
  TRACKING_TOKENS,
  type TrackingRepository,
  type TrackingSettingsProvider,
  type TrackingTokens,
} from '../ports';

export interface IssuedTrackingLink {
  /** Shown once: only its hash is stored. */
  readonly token: string;
  readonly expiresAt: Temporal.Instant;
}

/**
 * Issues a customer tracking link for a tracked delivery that has not ended: called by the
 * modules that tell the customer about their delivery (notifications, the marketplace adapter).
 */
@Injectable()
export class IssueTrackingLink {
  constructor(
    @Inject(TRACKING_REPOSITORY) private readonly tracking: TrackingRepository,
    @Inject(TRACKING_SETTINGS) private readonly settings: TrackingSettingsProvider,
    @Inject(TRACKING_TOKENS) private readonly tokens: TrackingTokens,
    @Inject(UNIT_OF_WORK) private readonly unitOfWork: UnitOfWork,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  perform(
    market: MarketContext,
    deliveryId: Id<'Delivery'>,
  ): Promise<Result<IssuedTrackingLink, TrackingFailure>> {
    // The token is drawn before the unit: the unit's work may run again on a conflict.
    const { token, hash } = this.tokens.issue();
    const link = issueTrackingLink(
      this.settings.get(market.marketId),
      deliveryId,
      hash,
      this.clock.now(),
    );
    return this.unitOfWork.run(market, async () => {
      const delivery = await this.tracking.findDelivery(market, deliveryId);
      if (delivery === undefined) return err(deliveryNotTracked());
      if (delivery.endedAt !== undefined) {
        return err(failure('tracking.ended', 'The delivery has ended'));
      }
      await this.tracking.insertLink(market, link);
      return ok({ token, expiresAt: link.expiresAt });
    });
  }
}
