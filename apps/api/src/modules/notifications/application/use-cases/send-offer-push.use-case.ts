import {
  err,
  ok,
  type CallContext,
  type Clock,
  type Result,
  type Temporal,
} from '@mondapac-drive/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { EventDelivery } from '../../../../platform/events/event-delivery';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { offerPush } from '../../domain/push-device';
import { ACCESS_DENIED, isSystem } from '../callers';
import type { NotificationsFailure } from '../failure';
import type {
  CourierSessions,
  NotificationSettingsProvider,
  PushDeviceRepository,
  PushSender,
} from '../ports';

/** The most devices one courier's push goes to (a session has one; a courier has few). */
export const MAX_DEVICES_PER_PUSH = 10;

/** One offer dispatch sent (`dispatch.offer-sent.v1`): ids and the expiry only. */
export interface OfferSentInput {
  readonly delivery: EventDelivery;
  readonly offerId: string;
  /** The courier's identity account id. */
  readonly courierId: string;
  readonly expiresAt: Temporal.Instant;
}

/** What one offer pushed: nothing (expired, no device, seen before) or how many devices. */
export type OfferPushOutcome =
  | { readonly pushed: number; readonly dropped: number }
  | { readonly skipped: 'expired' | 'no-device' | 'handled' };

export interface SendOfferPushDependencies {
  readonly devices: PushDeviceRepository;
  readonly sender: PushSender;
  readonly sessions: CourierSessions;
  readonly settings: NotificationSettingsProvider;
  readonly unitOfWork: UnitOfWork;
  readonly clock: Clock;
}

/**
 * Pushes a new offer to the courier's live devices: "New offer, expires in N s" with the offer
 * id only, never an address, a recipient or a merchant. Rule `system`, from the
 * `notifications.offer-push` subscription. An offer with less than a second left is not pushed.
 * The push goes out before the inbox unit (no external call inside a unit), so a delivery
 * repeated after a crash may push twice; the app shows the offer once, by its id. When no device
 * took the push and a failure may pass, the use case refuses so the event is retried through
 * the inbox; a device the push service no longer knows is dropped, and so is the device of a
 * session identity no longer holds live (checked at every push). When some devices took the push
 * and others failed, the event is handled and the failed ones miss this offer.
 */
export class SendOfferPush extends UseCase<OfferSentInput, OfferPushOutcome, NotificationsFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'notifications.send-offer-push',
    rule: { kind: 'system' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: SendOfferPushDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: OfferSentInput,
  ): Promise<Result<OfferPushOutcome, NotificationsFailure>> {
    if (!isSystem(context)) return err(ACCESS_DENIED);
    const { market } = context;
    const { devices, sender, settings, unitOfWork, clock } = this.deps;
    const now = clock.now();
    const push = offerPush(
      settings.get(market.marketId).offerPush,
      input.offerId,
      input.expiresAt,
      now,
    );
    if (push === undefined) return this.settle(context, input, [], { skipped: 'expired' });
    const live = await unitOfWork.run(
      market,
      async () => ok(await devices.liveOf(market, input.courierId, now, MAX_DEVICES_PER_PUSH)),
      { readOnly: true },
    );
    if (!live.ok) return live;
    if (live.value.length === 0) return this.settle(context, input, [], { skipped: 'no-device' });
    // Only the device of a session identity still holds live: a session that ended without a
    // sign-out (expired, idle, the app offline) never receives a push (Hassan M1).
    const liveSessions = await this.deps.sessions.liveOf(
      context,
      input.courierId,
      live.value.map((device) => device.sessionId),
    );
    if (liveSessions === undefined) {
      return err({
        code: 'push.sessions-unavailable',
        message: 'Identity did not answer; retried',
      });
    }
    const ended = live.value.filter((device) => !liveSessions.has(device.sessionId));
    const targets = live.value.filter((device) => liveSessions.has(device.sessionId));
    if (targets.length === 0) {
      return this.settle(
        context,
        input,
        ended.map((device) => device.id),
        { skipped: 'no-device' },
      );
    }
    const tickets = await sender.send(
      targets.map((device) => device.token),
      push,
    );
    let pushed = 0;
    let retryable = false;
    const gone: string[] = ended.map((device) => device.id);
    tickets.forEach((ticket, index) => {
      const device = targets[index];
      if (ticket.ok) pushed += 1;
      else if (ticket.deviceGone && device !== undefined) gone.push(device.id);
      else if (ticket.retryable) retryable = true;
    });
    if (pushed === 0 && retryable) {
      if (gone.length > 0) {
        await unitOfWork.run(market, async () => ok(await devices.removeByIds(market, gone)));
      }
      return err({ code: 'push.unavailable', message: 'The push service failed; retried' });
    }
    return this.settle(context, input, gone, { pushed, dropped: gone.length - ended.length });
  }

  /** Marks the event handled, dropping the devices the push service no longer knows. */
  private async settle(
    context: CallContext,
    input: OfferSentInput,
    gone: readonly string[],
    outcome: OfferPushOutcome,
  ): Promise<Result<OfferPushOutcome, NotificationsFailure>> {
    const { market } = context;
    const { devices, unitOfWork } = this.deps;
    const done = await unitOfWork.runOnce(market, input.delivery, async () =>
      ok(gone.length === 0 ? 0 : await devices.removeByIds(market, gone)),
    );
    if (!done.ok) return done;
    return ok(done.value.handled ? outcome : { skipped: 'handled' });
  }
}
