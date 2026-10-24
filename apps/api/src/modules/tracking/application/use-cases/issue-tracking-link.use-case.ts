import {
  err,
  ok,
  type CallContext,
  type Clock,
  type Result,
  type Temporal,
} from '@mondapac-drive/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { issueTrackingLink } from '../../domain/tracking-link';
import { ACCESS_DENIED, isSystem } from '../callers';
import { deliveryNotTracked, failure, type TrackingFailure } from '../failure';
import type { TrackingRepository, TrackingSettingsProvider, TrackingTokens } from '../ports';
import type { DeliveryRef } from './delivery-trail.use-case';

export interface IssuedTrackingLink {
  /** Shown once: only its hash is stored. */
  readonly token: string;
  readonly expiresAt: Temporal.Instant;
}

export interface IssueTrackingLinkDependencies {
  readonly tracking: TrackingRepository;
  readonly settings: TrackingSettingsProvider;
  readonly tokens: TrackingTokens;
  readonly unitOfWork: UnitOfWork;
  readonly clock: Clock;
}

/**
 * Issues a customer tracking link for a tracked delivery that has not ended: called by the
 * modules that tell the customer about their delivery (notifications, the marketplace adapter),
 * from their jobs and event subscribers. Rule `system`.
 */
export class IssueTrackingLink extends UseCase<DeliveryRef, IssuedTrackingLink, TrackingFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'tracking.issue-tracking-link',
    rule: { kind: 'system' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: IssueTrackingLinkDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: DeliveryRef,
  ): Promise<Result<IssuedTrackingLink, TrackingFailure>> {
    if (!isSystem(context)) return Promise.resolve(err(ACCESS_DENIED));
    const { market } = context;
    const { tracking, settings, tokens, unitOfWork, clock } = this.deps;
    // The token is drawn before the unit: the unit's work may run again on a conflict.
    const { token, hash } = tokens.issue();
    const link = issueTrackingLink(
      settings.get(market.marketId),
      input.deliveryId,
      hash,
      clock.now(),
    );
    return unitOfWork.run(market, async () => {
      const delivery = await tracking.findDelivery(market, input.deliveryId);
      if (delivery === undefined) return err(deliveryNotTracked());
      if (delivery.endedAt !== undefined) {
        return err(failure('tracking.ended', 'The delivery has ended'));
      }
      await tracking.insertLink(market, link);
      return ok({ token, expiresAt: link.expiresAt });
    });
  }
}
