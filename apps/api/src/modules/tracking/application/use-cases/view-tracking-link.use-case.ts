import {
  err,
  ok,
  type CallContext,
  type Clock,
  type MarketContext,
  type Result,
} from '@mondapac-drive/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
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
import type {
  EtaProvider,
  LivePositionStore,
  TrackingRepository,
  TrackingSettingsProvider,
  TrackingTokens,
} from '../ports';

/** The refusals of every tracking use case, for the entry points that map them. */
export type { TrackingFailure };

export interface TrackingLinkRef {
  /** The token as the customer's link carries it. */
  readonly token: string;
}

export interface ViewTrackingLinkDependencies {
  readonly tracking: TrackingRepository;
  readonly tokens: TrackingTokens;
  readonly positions: LivePositionStore;
  readonly eta: EtaProvider;
  readonly settings: TrackingSettingsProvider;
  readonly unitOfWork: UnitOfWork;
  readonly clock: Clock;
}

const MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  'tracking.link-not-found': 'No such tracking link',
  'tracking.link-expired': 'The tracking link has expired',
  'tracking.ended': 'The delivery has ended',
});

/**
 * What a customer's tracking link shows (no login: the token is the only credential). An unknown
 * or malformed token, an expired link and an ended delivery answer a refusal and nothing else.
 * Rule `anonymous`: the body always runs with the Market's anonymous actor.
 */
export class ViewTrackingLink extends UseCase<TrackingLinkRef, CustomerView, TrackingFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'tracking.view-tracking-link',
    rule: { kind: 'anonymous' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: ViewTrackingLinkDependencies,
  ) {
    super(gate);
  }

  /** How often the tracking page's live channel sends a new view (Market setting). */
  refreshIntervalSeconds(market: MarketContext): number {
    return this.deps.settings.get(market.marketId).streamIntervalSeconds;
  }

  protected async handle(
    context: CallContext,
    input: TrackingLinkRef,
  ): Promise<Result<CustomerView, TrackingFailure>> {
    const { market } = context;
    const { tracking, tokens, positions, eta, unitOfWork, clock } = this.deps;
    const hash = tokens.hashOf(input.token);
    if (hash === undefined) return refused('tracking.link-not-found');
    const found = await unitOfWork.run(
      market,
      async (): Promise<Result<{ delivery: TrackedDelivery; showPosition: boolean }, string>> => {
        const link = await tracking.findLink(market, hash);
        if (link === undefined) return err('tracking.link-not-found');
        const open = checkLinkOpen(link, clock.now());
        if (!open.ok) return err(open.error.code);
        const delivery = await tracking.findDelivery(market, link.deliveryId);
        if (delivery === undefined) return err('tracking.link-not-found');
        const carried =
          delivery.courierId === undefined
            ? []
            : await tracking.activeDeliveriesOf(market, delivery.courierId);
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
      courier = await positions.lastKnown(market, delivery.courierId);
      if (courier !== undefined && delivery.vehicle !== undefined) {
        etaSeconds = await eta.etaSeconds(
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
