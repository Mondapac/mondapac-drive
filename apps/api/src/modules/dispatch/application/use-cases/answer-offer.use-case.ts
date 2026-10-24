import {
  err,
  ok,
  parseId,
  type CallContext,
  type Clock,
  type Id,
  type Result,
} from '@mondapac-drive/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { OutboxWriter } from '../../../../platform/events/outbox-writer';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { OFFER_ANSWER } from '../../contracts/permissions';
import { answerOffer, offerOf, type DispatchJob } from '../../domain/dispatch-job';
import { courierOf } from '../callers';
import { accessDenied, offerNotFound, refusingBrokenRules, type DispatchFailure } from '../failure';
import type { DispatchJobRepository } from '../ports';

export interface AnswerOfferInput {
  /** The offer's id, as the route received it: checked here. */
  readonly offerId: string;
  readonly answer: 'accept' | 'decline';
}

export interface OfferAnswered {
  readonly deliveryId: Id<'Delivery'>;
  /** True when the courier now has the delivery. */
  readonly assigned: boolean;
}

export interface AnswerOfferDependencies {
  readonly jobs: DispatchJobRepository;
  readonly outbox: OutboxWriter;
  readonly unitOfWork: UnitOfWork;
  readonly clock: Clock;
}

/**
 * A courier accepts or declines an offer they hold. The courier is the signed-in courier (its
 * account id), never a path or body field; an offer made to another courier, or one that does
 * not exist, is refused alike with `offer.not-found`, so no one learns of another courier's
 * offers. An accept assigns the delivery (`dispatch.courier-assigned`, which the delivery
 * records); after the last decline of a wave the next sweep (within seconds) sends the next
 * one, as the system, so no courier call reaches fleet or tracking. Rule
 * `permissions [dispatch.offer.answer]`, couriers only.
 */
export class AnswerOffer extends UseCase<AnswerOfferInput, OfferAnswered, DispatchFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'dispatch.answer-offer',
    rule: { kind: 'permissions', allOf: [OFFER_ANSWER.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: AnswerOfferDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: AnswerOfferInput,
  ): Promise<Result<OfferAnswered, DispatchFailure>> {
    const courierId = courierOf(context);
    if (courierId === null) return err(accessDenied());
    const offerId = parseId<'DispatchOffer'>(input.offerId);
    if (!offerId.ok) return err(offerNotFound());
    const { jobs, outbox, unitOfWork, clock } = this.deps;
    const { market } = context;

    const answered = await unitOfWork.run(market, () =>
      refusingBrokenRules<DispatchJob>(async () => {
        const job = await jobs.findByOffer(market, offerId.value);
        if (job === undefined || offerOf(job, offerId.value, courierId) === undefined) {
          return err(offerNotFound());
        }
        const change = answerOffer(job, offerId.value, courierId, input.answer, clock.now());
        await jobs.update(market, change.job);
        await outbox.append(context, change.events);
        return ok(change.job);
      }),
    );
    if (!answered.ok) return answered;
    const job = answered.value;
    return ok({ deliveryId: job.deliveryId, assigned: job.assignment?.courierId === courierId });
  }
}
