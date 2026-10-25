import { err, ok, type CallContext, type Clock, type Result } from '@mondapac-drive/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { AuditWriter } from '../../../../platform/audit/audit-writer';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { WEBHOOK_CALL_RESEND } from '../../contracts/permissions';
import { WebhookCallResentAudit } from '../../domain/audit';
import { resend } from '../../domain/outbound-message';
import { ACCESS_DENIED, isAdmin } from '../callers';
import { notFound, refusingBrokenRules, type NotificationsFailure } from '../failure';
import type { DeadWebhookCall, OutboundRepository, WebhookCall } from '../ports';

/** A queued call as the operator routes answer it. */
export type { DeadWebhookCall, WebhookCall } from '../ports';

export interface ResendWebhookCallDependencies {
  readonly outbound: OutboundRepository;
  readonly audit: AuditWriter;
  readonly unitOfWork: UnitOfWork;
  readonly clock: Clock;
}

/**
 * An operator sends a dead-lettered webhook call again: it is due at once, with a fresh count
 * of attempts and the same body and event id, so the merchant's deduplication still holds.
 * Rule `permissions [notifications.webhook-call.resend]`, admins only. Audited.
 */
export class ResendWebhookCall extends UseCase<
  { readonly callId: string },
  WebhookCall,
  NotificationsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'notifications.resend-webhook-call',
    rule: { kind: 'permissions', allOf: [WEBHOOK_CALL_RESEND.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: ResendWebhookCallDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: { readonly callId: string },
  ): Promise<Result<WebhookCall, NotificationsFailure>> {
    if (!isAdmin(context)) return Promise.resolve(err(ACCESS_DENIED));
    const { market } = context;
    const { outbound, audit, unitOfWork, clock } = this.deps;
    return unitOfWork.run(market, () =>
      refusingBrokenRules(async () => {
        const call = await outbound.findCall(market, input.callId);
        if (call === undefined) return err(notFound('webhook-call'));
        const next: WebhookCall = { ...call, ...resend(call, clock.now()) };
        if (!(await outbound.saveCall(market, next, call.attempts))) {
          return err({ code: 'webhook-call.changed', message: 'The call changed; try again' });
        }
        await audit.record(
          context,
          WebhookCallResentAudit.entry(call.id as never, {
            before: { attempts: call.attempts },
            after: { subscriptionId: call.subscriptionId as never },
          }),
        );
        return ok(next);
      }),
    );
  }
}

/** Dead calls one list answers. */
export const DEAD_CALL_LIST_LIMIT = 100;

/**
 * The dead-lettered webhook calls of the Market, the most recently dead first, for an operator
 * to re-send. Rule `permissions [notifications.webhook-call.resend]`, admins only. The body
 * holds ids and statuses only; it is not answered here.
 */
export class ListDeadWebhookCalls extends UseCase<
  Record<string, never>,
  DeadWebhookCall[],
  NotificationsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'notifications.list-dead-webhook-calls',
    rule: { kind: 'permissions', allOf: [WEBHOOK_CALL_RESEND.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: {
      readonly outbound: OutboundRepository;
      readonly unitOfWork: UnitOfWork;
    },
  ) {
    super(gate);
  }

  protected handle(context: CallContext): Promise<Result<DeadWebhookCall[], NotificationsFailure>> {
    if (!isAdmin(context)) return Promise.resolve(err(ACCESS_DENIED));
    const { market } = context;
    return this.deps.unitOfWork.run(
      market,
      async () => ok(await this.deps.outbound.deadCalls(market, DEAD_CALL_LIST_LIMIT)),
      { readOnly: true },
    );
  }
}
