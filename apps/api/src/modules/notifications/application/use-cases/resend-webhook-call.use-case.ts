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
import { resend } from '../../domain/outbound-message';
import { notFound, refusingBrokenRules, type NotificationsFailure } from '../failure';
import { OUTBOUND_REPOSITORY, type OutboundRepository, type WebhookCall } from '../ports';

/**
 * An operator sends a dead-lettered webhook call again: it is due at once, with a fresh count
 * of attempts and the same body and event id, so the merchant's deduplication still holds.
 * The operator is checked by identity (WP2) once it gates this use case; no route reaches it
 * before that.
 */
@Injectable()
export class ResendWebhookCall {
  constructor(
    @Inject(OUTBOUND_REPOSITORY) private readonly outbound: OutboundRepository,
    @Inject(UNIT_OF_WORK) private readonly unitOfWork: UnitOfWork,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  run(market: MarketContext, callId: string): Promise<Result<WebhookCall, NotificationsFailure>> {
    return this.unitOfWork.run(market, () =>
      refusingBrokenRules(async () => {
        const call = await this.outbound.findCall(market, callId);
        if (call === undefined) return err(notFound('webhook-call'));
        const next: WebhookCall = { ...call, ...resend(call, this.clock.now()) };
        if (!(await this.outbound.saveCall(market, next, call.attempts))) {
          return err({ code: 'webhook-call.changed', message: 'The call changed; try again' });
        }
        return ok(next);
      }),
    );
  }
}
