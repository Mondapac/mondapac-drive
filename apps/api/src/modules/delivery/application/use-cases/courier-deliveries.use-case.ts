import { err, ok, parseId } from '@mondapac-drive/shared-kernel';
import type { CallContext, Result } from '@mondapac-drive/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { ASSIGNMENT_REPORT, ASSIGNMENT_VIEW } from '../../contracts/permissions';
import {
  applyDeliveryEvent,
  type DeliveryEventInput,
  type DeliveryState,
  type ProofOfDelivery,
} from '../../domain/delivery';
import { isFinal, TRANSITIONS, type DeliveryEventType } from '../../domain/delivery-status';
import {
  ACCESS_DENIED,
  courierOf,
  notFound,
  readDelivery,
  saveChange,
  type DeliveryAccessDependencies,
} from '../deliveries';
import { refusingBrokenRules, type DeliveryFailure } from '../failure';
import type { ProofPhotoRepository, RecipientPins } from '../ports';
import type { DeliveryRef } from './merchant-deliveries.use-case';

/** The events a courier reports on its own assignment: progress, proof and the return. */
export const COURIER_EVENT_TYPES: readonly DeliveryEventType[] = Object.freeze([
  'arrived_at_pickup',
  'picked_up',
  'arrived_at_dropoff',
  'delivered',
  'delivery_failed',
  'return_started',
  'returned',
]);

/** What the courier reports: never a courier id or a reason code; proof as offered. */
export type CourierReport = Omit<DeliveryEventInput, 'courierId' | 'reasonCode' | 'proof'> & {
  readonly proof?: OfferedProof;
};

export interface ReportInput extends DeliveryRef {
  readonly report: CourierReport;
}

/**
 * A delivery assigned to the courier. Rule `permissions [delivery.assignment.view]`. A delivery
 * not assigned to this courier, or one that has ended (delivered, returned, cancelled), answers
 * `delivery.not-found`: the courier's access to the stops and contacts lasts as long as the job
 * (Hassan, WP2 review).
 */
export class ViewAssignment extends UseCase<DeliveryRef, DeliveryState, DeliveryFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'delivery.view-assignment',
    rule: { kind: 'permissions', allOf: [ASSIGNMENT_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: DeliveryAccessDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: DeliveryRef,
  ): Promise<Result<DeliveryState, DeliveryFailure>> {
    const courierId = courierOf(context);
    if (courierId === null) return Promise.resolve(err(ACCESS_DENIED));
    return readDelivery(
      this.deps,
      context.market,
      input.deliveryId,
      (delivery) => delivery.courierId === courierId && !isFinal(delivery.status),
    );
  }
}

/** The proof a courier offers with `delivered`: checked by the server before it is recorded. */
export type OfferedProof =
  | { readonly kind: 'pin'; readonly pin: string }
  | { readonly kind: 'photo'; readonly photoRef: string };

export interface ReportAssignmentDependencies extends DeliveryAccessDependencies {
  readonly pins: RecipientPins;
  readonly photos: ProofPhotoRepository;
}

/** What the unit decided: the step was recorded, or a wrong PIN was counted. */
type ReportOutcome =
  | { readonly kind: 'recorded'; readonly delivery: DeliveryState }
  | { readonly kind: 'wrong-pin'; readonly attemptsLeft: number };

/**
 * The courier reports on its own assignment: arrival, pickup with the cold-chain reading,
 * delivery with proof, a failure with a reason, the return. Rule `permissions
 * [delivery.assignment.report]`. Only the courier the delivery is assigned to, and only the
 * events of {@link COURIER_EVENT_TYPES}: assigning and cancelling are a dispatcher's.
 *
 * Proof of delivery is checked here, in the unit that records the step:
 * - a PIN takes one of the Market's `maxPinAttempts` (a row lock, so parallel guesses queue),
 *   then is compared in constant time with the delivery's PIN. A wrong one answers
 *   `delivery.pin-wrong` with the attempts left (the attempt commits, the step does not); with
 *   none left every PIN answers `delivery.pin-locked`, and only a photo proves the hand-over.
 *   Only that the PIN matched is stored, never the PIN.
 * - a photo is a `photoRef` of a proof photo uploaded for this delivery; any other answers
 *   `delivery.proof-photo-unknown`.
 */
export class ReportAssignmentEvent extends UseCase<ReportInput, DeliveryState, DeliveryFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'delivery.report-assignment-event',
    rule: { kind: 'permissions', allOf: [ASSIGNMENT_REPORT.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: ReportAssignmentDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: ReportInput,
  ): Promise<Result<DeliveryState, DeliveryFailure>> {
    const courierId = courierOf(context);
    if (courierId === null) return err(ACCESS_DENIED);
    // A courier id or reason code smuggled into the body is dropped: the courier is always the
    // actor, and the reason code is the use case's.
    const {
      courierId: dropped,
      reasonCode: droppedCode,
      proof: offered,
      ...report
    } = input.report as CourierReport & { courierId?: unknown; reasonCode?: unknown };
    void dropped;
    void droppedCode;
    if (!COURIER_EVENT_TYPES.includes(report.type)) {
      return err({
        code: 'delivery.event-not-allowed',
        message: `You cannot record ${report.type}`,
      });
    }
    const { market } = context;
    const settings = this.deps.markets.get(market.marketId);
    const decided = await this.deps.unitOfWork.run(market, () =>
      refusingBrokenRules(async (): Promise<Result<ReportOutcome, DeliveryFailure>> => {
        const delivery = await this.deps.deliveries.findById(market, input.deliveryId);
        if (
          delivery === undefined ||
          delivery.courierId !== courierId ||
          isFinal(delivery.status)
        ) {
          return err(notFound(input.deliveryId));
        }
        // The lifecycle first: a PIN offered in the wrong state is refused, not counted.
        if (!TRANSITIONS[report.type].from.includes(delivery.status)) {
          return err({
            code: 'delivery.invalid-transition',
            message: `Cannot record ${report.type} while the delivery is ${delivery.status}`,
          });
        }
        const now = this.deps.clock.now();
        let proof: ProofOfDelivery | undefined;
        if (offered?.kind === 'pin') {
          // Every other rule of the step first (a cold-chain reading, say): a refusal for another
          // reason would otherwise tell a right PIN from a wrong one without using an attempt.
          applyDeliveryEvent(delivery, { ...report, proof: { kind: 'pin' } }, now, settings);
          const { pinLength, maxPinAttempts } = settings.proofOfDelivery;
          const used = await this.deps.deliveries.claimPinAttempt(
            market,
            delivery.id,
            maxPinAttempts,
          );
          if (used === null) return err(PIN_LOCKED);
          if (!this.deps.pins.matches(market, delivery.id, pinLength, offered.pin)) {
            return ok({ kind: 'wrong-pin', attemptsLeft: Math.max(maxPinAttempts - used, 0) });
          }
          proof = { kind: 'pin' };
        } else if (offered?.kind === 'photo') {
          const photoId = parseId<'ProofPhoto'>(offered.photoRef);
          if (
            !photoId.ok ||
            !(await this.deps.photos.belongsTo(market, delivery.id, courierId, photoId.value))
          ) {
            return err({
              code: 'delivery.proof-photo-unknown',
              message: 'No proof photo with this reference was uploaded for this delivery',
            });
          }
          proof = { kind: 'photo', photoRef: photoId.value };
        }
        const event: DeliveryEventInput = { ...report, ...(proof ? { proof } : {}) };
        const next = applyDeliveryEvent(delivery, event, now, settings);
        await saveChange(this.deps, context, delivery, next);
        return ok({ kind: 'recorded', delivery: next });
      }),
    );
    if (!decided.ok) return decided;
    if (decided.value.kind === 'recorded') return ok(decided.value.delivery);
    const { attemptsLeft } = decided.value;
    return err(
      attemptsLeft === 0
        ? PIN_LOCKED
        : {
            code: 'delivery.pin-wrong',
            message: `That PIN is not the recipient's; ${attemptsLeft} attempts left`,
          },
    );
  }
}

const PIN_LOCKED: DeliveryFailure = Object.freeze({
  code: 'delivery.pin-locked',
  message: 'Too many wrong PINs: prove the delivery with a photo',
});
