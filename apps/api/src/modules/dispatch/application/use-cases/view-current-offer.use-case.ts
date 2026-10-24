import {
  err,
  ok,
  Temporal,
  type CallContext,
  type Clock,
  type GeoPoint,
  type Id,
  type Result,
} from '@mondapac-drive/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { OFFER_VIEW } from '../../contracts/permissions';
import type { Temperature } from '../../domain/courier';
import { openOfferOf } from '../../domain/dispatch-job';
import { courierOf } from '../callers';
import { accessDenied, type DispatchFailure } from '../failure';
import type { DispatchJobRepository } from '../ports';

/** What the courier app shows of an offer: where, how far, how cold, and until when. */
export interface CourierOffer {
  readonly offerId: Id<'DispatchOffer'>;
  readonly deliveryId: Id<'Delivery'>;
  readonly expiresAt: Temporal.Instant;
  readonly pickup: { readonly address: string; readonly point: GeoPoint };
  readonly dropoff: { readonly address: string; readonly point: GeoPoint };
  readonly tripDistanceMetres: number;
  readonly temperature: Temperature;
}

export interface ViewCurrentOfferDependencies {
  readonly jobs: DispatchJobRepository;
  readonly unitOfWork: UnitOfWork;
  readonly clock: Clock;
}

/**
 * The signed-in courier's open offer, the one that expires first, or null: the courier app
 * polls it. Only the courier who holds an offer sees the delivery's addresses, and only while
 * the offer is open. Rule `permissions [dispatch.offer.view]`, couriers only.
 */
export class ViewCurrentOffer extends UseCase<
  Record<string, never>,
  CourierOffer | null,
  DispatchFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'dispatch.view-current-offer',
    rule: { kind: 'permissions', allOf: [OFFER_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: ViewCurrentOfferDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
  ): Promise<Result<CourierOffer | null, DispatchFailure>> {
    const courierId = courierOf(context);
    if (courierId === null) return err(accessDenied());
    const { jobs, unitOfWork, clock } = this.deps;
    const { market } = context;
    const read = await unitOfWork.run(
      market,
      async () => ok(await jobs.findWithPendingOfferFor(market, courierId)),
      { readOnly: true },
    );
    if (!read.ok) return read;
    const now = clock.now();
    const open = read.value.flatMap((job) => {
      const offer = openOfferOf(job, courierId, now);
      const { stops } = job;
      if (offer === undefined || stops === undefined) return [];
      return [
        {
          offerId: offer.id,
          deliveryId: job.deliveryId,
          expiresAt: offer.expiresAt,
          pickup: { address: stops.pickupAddress, point: job.requirements.pickup },
          dropoff: { address: stops.dropoffAddress, point: stops.dropoff },
          tripDistanceMetres: stops.tripDistanceMetres,
          temperature: job.requirements.temperature,
        },
      ];
    });
    open.sort((a, b) => Temporal.Instant.compare(a.expiresAt, b.expiresAt));
    return ok(open[0] ?? null);
  }
}
