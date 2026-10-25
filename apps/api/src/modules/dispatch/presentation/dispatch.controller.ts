import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { CallContext } from '@mondapac-drive/shared-kernel';
import { Call } from '../../../platform/call-context/call-context.decorator';
import {
  ReadsSession,
  RoutePopulation,
} from '../../../platform/call-context/route-population.decorator';
import { AnswerOffer } from '../application/use-cases/answer-offer.use-case';
import { AssignCourier } from '../application/use-cases/assign-courier.use-case';
import { RestartOffering } from '../application/use-cases/restart-offering.use-case';
import {
  ViewCurrentOffer,
  type CourierOffer,
} from '../application/use-cases/view-current-offer.use-case';
import { ViewDispatchJob } from '../application/use-cases/view-dispatch-job.use-case';
import type { DispatchJob, Offer } from '../domain/dispatch-job';
import { answer, parsed } from './dispatch-http';
import { assignBody, emptyBody } from './dispatch.schemas';

const offerBody = (offer: CourierOffer) => ({
  id: offer.offerId,
  deliveryId: offer.deliveryId,
  expiresAt: offer.expiresAt.toString(),
  pickup: {
    suburb: offer.pickup.suburb,
    postcode: offer.pickup.postcode,
    point: offer.pickup.point,
  },
  dropoff: {
    suburb: offer.dropoff.suburb,
    postcode: offer.dropoff.postcode,
    point: offer.dropoff.point,
  },
  distanceMetres: offer.tripDistanceMetres,
  temperature: offer.temperature,
  // Money on the wire, as payouts answers it: minor units as decimal text.
  earnings:
    offer.earnings === null
      ? null
      : { amount: offer.earnings.amount.toString(), currency: offer.earnings.currency },
});

const sentOfferBody = (offer: Offer) => ({
  id: offer.id,
  courierId: offer.courierId,
  vehicle: offer.vehicle,
  round: offer.round,
  status: offer.status,
  sentAt: offer.sentAt.toString(),
  expiresAt: offer.expiresAt.toString(),
  answeredAt: offer.answeredAt?.toString() ?? null,
});

/** A job for the panel: no addresses, which the delivery's own page shows. */
const jobBody = (job: DispatchJob) => ({
  id: job.id,
  deliveryId: job.deliveryId,
  status: job.status,
  round: job.round,
  opensAt: job.opensAt.toString(),
  nextActionAt: job.nextActionAt?.toString() ?? null,
  assignment:
    job.assignment === undefined
      ? null
      : {
          courierId: job.assignment.courierId,
          vehicle: job.assignment.vehicle,
          method: job.assignment.method,
          at: job.assignment.at.toString(),
        },
  offers: job.offers.map(sentOfferBody),
});

/**
 * The courier app's offers (`Authorization: Bearer <session token>`): the courier's current
 * offer, and its answer. The courier is the session's account, never a path or body field; an
 * offer of another courier answers 404 like one that does not exist.
 */
@ApiTags('dispatch')
@ApiBearerAuth()
@RoutePopulation('courier')
@Controller('dispatch/courier/offers')
export class CourierOffersController {
  constructor(
    private readonly viewOffer: ViewCurrentOffer,
    private readonly answerOffer: AnswerOffer,
  ) {}

  @Get('current')
  @ReadsSession()
  @ApiOperation({
    summary: "The courier's open offer that expires first, or null",
    description:
      "Each stop's suburb (null when unknown), postcode and point, never its address: the " +
      "address is on the delivery's courier job after accepting. Also the trip distance, the " +
      'temperature, the expiry and ' +
      '`earnings`: what the courier earns for it, `{ amount, currency }` in minor units as ' +
      'decimal text, tax included and without waiting time; null for an employee, a courier ' +
      'without a payee profile or a vehicle the Market has no courier rate for.',
  })
  async current(@Call() context: CallContext) {
    const offer = answer(await this.viewOffer.execute(context, {}));
    return { offer: offer === null ? null : offerBody(offer) };
  }

  @Post(':offerId/accept')
  @HttpCode(200)
  @ReadsSession()
  @ApiOperation({
    summary: 'Accept the offer: the courier has the delivery',
    description: '409 `offer.not-pending` once it was answered or withdrawn; 410 `offer.expired`.',
  })
  async accept(
    @Call() context: CallContext,
    @Param('offerId') offerId: string,
    @Body() body: unknown,
  ) {
    parsed(() => emptyBody.parse(body));
    const done = answer(await this.answerOffer.execute(context, { offerId, answer: 'accept' }));
    return { deliveryId: done.deliveryId };
  }

  @Post(':offerId/decline')
  @HttpCode(204)
  @ReadsSession()
  @ApiOperation({ summary: 'Decline the offer: it is not offered to this courier again' })
  async decline(
    @Call() context: CallContext,
    @Param('offerId') offerId: string,
    @Body() body: unknown,
  ): Promise<void> {
    parsed(() => emptyBody.parse(body));
    answer(await this.answerOffer.execute(context, { offerId, answer: 'decline' }));
  }
}

/**
 * The admin panel's dispatch actions for dispatchers (the admin session cookie): a delivery's
 * job with its offers, assign or reassign its courier, and dispatch it again after every round
 * lapsed. Assignments and restarts are audited. Taking a courier off a delivery is the
 * delivery's own unassign route.
 */
@ApiTags('dispatch')
@RoutePopulation('admin')
@Controller('dispatch/admin/deliveries/:deliveryId')
export class DispatcherController {
  constructor(
    private readonly viewJob: ViewDispatchJob,
    private readonly assignCourier: AssignCourier,
    private readonly restartOffering: RestartOffering,
  ) {}

  @Get()
  @ReadsSession()
  @ApiOperation({ summary: "A delivery's dispatch job: rounds, offers and their answers" })
  async job(@Call() context: CallContext, @Param('deliveryId') deliveryId: string) {
    return jobBody(answer(await this.viewJob.execute(context, { deliveryId })));
  }

  @Post('assign')
  @HttpCode(200)
  @ReadsSession()
  @ApiOperation({
    summary: 'Assign or reassign the courier (audited)',
    description:
      'Offers still out are withdrawn. The courier must be an active courier account of the ' +
      'Market (422 `dispatch.courier-not-active`).',
  })
  async assign(
    @Call() context: CallContext,
    @Param('deliveryId') deliveryId: string,
    @Body() body: unknown,
  ) {
    const input = parsed(() => assignBody.parse(body));
    return jobBody(answer(await this.assignCourier.execute(context, { deliveryId, ...input })));
  }

  @Post('redispatch')
  @HttpCode(200)
  @ReadsSession()
  @ApiOperation({
    summary: 'Offer the delivery again after every round lapsed (audited)',
    description: '409 `dispatch.not-exhausted` unless the job is exhausted.',
  })
  async redispatch(
    @Call() context: CallContext,
    @Param('deliveryId') deliveryId: string,
    @Body() body: unknown,
  ) {
    parsed(() => emptyBody.parse(body));
    return jobBody(answer(await this.restartOffering.execute(context, { deliveryId })));
  }
}
