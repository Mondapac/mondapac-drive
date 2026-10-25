import {
  err,
  ok,
  Temporal,
  type CallContext,
  type Clock,
  type GeoPoint,
  type Id,
  type Money,
  type Result,
} from '@mondapac-drive/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { OFFER_VIEW } from '../../contracts/permissions';
import type { Temperature } from '../../domain/courier';
import { openOfferOf, type OfferArea } from '../../domain/dispatch-job';
import { courierOf } from '../callers';
import { accessDenied, type DispatchFailure } from '../failure';
import type { DispatchJobRepository, OfferEarnings } from '../ports';

/** What the courier app shows of an offer: where, how far, how cold, and until when. */
export interface CourierOffer {
  readonly offerId: Id<'DispatchOffer'>;
  readonly deliveryId: Id<'Delivery'>;
  readonly expiresAt: Temporal.Instant;
  readonly pickup: OfferArea & { readonly point: GeoPoint };
  readonly dropoff: OfferArea & { readonly point: GeoPoint };
  readonly tripDistanceMetres: number;
  readonly temperature: Temperature;
  /**
   * What the courier earns for it, tax included, without waiting time (payouts' quote); null for
   * an employee, a courier without a payee profile or a vehicle the Market has no rate for.
   */
  readonly earnings: Money | null;
}

export interface ViewCurrentOfferDependencies {
  readonly jobs: DispatchJobRepository;
  readonly earnings: OfferEarnings;
  readonly unitOfWork: UnitOfWork;
  readonly clock: Clock;
}

/**
 * The signed-in courier's open offer, the one that expires first, or null: the courier app
 * polls it. Before accepting, the courier sees each stop's suburb and postcode and the points,
 * never the addresses (security L3): those are on delivery's job once the courier has it. Only
 * the courier who holds an offer sees even that, and only while the offer is open. The offer carries what the courier will earn for it, priced by payouts
 * after the read unit closes. Rule `permissions [dispatch.offer.view]`, couriers only.
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
    const { jobs, earnings, unitOfWork, clock } = this.deps;
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
          pickup: { ...stops.pickupArea, point: job.requirements.pickup },
          dropoff: { ...stops.dropoffArea, point: stops.dropoff },
          tripDistanceMetres: stops.tripDistanceMetres,
          temperature: job.requirements.temperature,
          vehicle: job.requirements.minimumVehicle,
        },
      ];
    });
    open.sort((a, b) => Temporal.Instant.compare(a.expiresAt, b.expiresAt));
    const first = open[0];
    if (first === undefined) return ok(null);
    const { vehicle, ...offer } = first;
    const pay = await earnings.forOffer(context, {
      deliveryId: offer.deliveryId,
      vehicle,
      distanceMetres: offer.tripDistanceMetres,
      temperature: offer.temperature,
    });
    return ok({ ...offer, earnings: pay });
  }
}
