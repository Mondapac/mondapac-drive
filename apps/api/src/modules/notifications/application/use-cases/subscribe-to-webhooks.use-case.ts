import {
  err,
  ok,
  type CallContext,
  type Clock,
  type IdGenerator,
  type Result,
} from '@mondapac-drive/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { AuditWriter } from '../../../../platform/audit/audit-writer';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { WEBHOOK_MANAGE } from '../../contracts/permissions';
import { WebhookSubscribedAudit } from '../../domain/audit';
import { isWebhookEventType, type WebhookEventType } from '../../domain/delivery-change';
import {
  createSubscription,
  MAX_SUBSCRIPTIONS_PER_MERCHANT,
  type WebhookSubscription,
} from '../../domain/webhook-subscription';
import { parseWebhookUrl } from '../../domain/webhook-url';
import { ACCESS_DENIED, merchantOf } from '../callers';
import { refusingBrokenRules, type NotificationsFailure } from '../failure';
import type { WebhookSigner, WebhookSubscriptionRepository } from '../ports';

export interface SubscribeInput {
  readonly url: string;
  readonly eventTypes: readonly string[];
}

/** A subscription and its signing secret: the only answers that ever show the secret. */
export interface SubscriptionWithSecret {
  readonly subscription: WebhookSubscription;
  readonly secret: string;
}

export interface SubscriptionDependencies {
  readonly subscriptions: WebhookSubscriptionRepository;
  readonly signer: WebhookSigner;
  readonly audit: AuditWriter;
  readonly unitOfWork: UnitOfWork;
  readonly ids: IdGenerator;
  readonly clock: Clock;
}

/** The event types of a request, each one known; anything else is refused. */
export function eventTypesOf(
  raw: readonly string[],
): Result<WebhookEventType[], NotificationsFailure> {
  const eventTypes: WebhookEventType[] = [];
  for (const type of raw) {
    if (!isWebhookEventType(type)) {
      return err({
        code: 'webhook-subscription.unknown-event-type',
        message: 'Unknown event type',
      });
    }
    eventTypes.push(type);
  }
  return ok(eventTypes);
}

/**
 * The merchant of the API key subscribes an HTTPS endpoint to delivery events and receives its
 * signing secret, once. Rule `permissions [notifications.webhook.manage]`. The URL passes the
 * SSRF guard here (public HTTPS host, no credentials, no private literal) and again at every
 * send (the resolved address). Audited, without the URL.
 */
export class SubscribeToWebhooks extends UseCase<
  SubscribeInput,
  SubscriptionWithSecret,
  NotificationsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'notifications.subscribe-to-webhooks',
    rule: { kind: 'permissions', allOf: [WEBHOOK_MANAGE.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: SubscriptionDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: SubscribeInput,
  ): Promise<Result<SubscriptionWithSecret, NotificationsFailure>> {
    const merchantId = merchantOf(context);
    if (merchantId === null) return err(ACCESS_DENIED);
    const { market } = context;
    const { subscriptions, signer, audit, unitOfWork, ids, clock } = this.deps;
    const url = parseWebhookUrl(input.url);
    if (!url.ok) return err({ code: url.error, message: 'The webhook URL is not allowed' });
    const eventTypes = eventTypesOf(input.eventTypes);
    if (!eventTypes.ok) return eventTypes;
    const subscription = await unitOfWork.run(market, () =>
      refusingBrokenRules(async () => {
        const active = await subscriptions.activeOf(market, merchantId);
        if (active.length >= MAX_SUBSCRIPTIONS_PER_MERCHANT) {
          return err({
            code: 'webhook-subscription.limit',
            message: `At most ${MAX_SUBSCRIPTIONS_PER_MERCHANT} active subscriptions`,
          });
        }
        const created = createSubscription({
          id: ids.next<'WebhookSubscription'>(),
          marketId: market.marketId,
          merchantId,
          url: url.value,
          eventTypes: eventTypes.value,
          createdAt: clock.now(),
        });
        await subscriptions.insert(market, created);
        await audit.record(
          context,
          WebhookSubscribedAudit.entry(created.id as never, {
            after: { eventTypes: [...created.eventTypes], secretVersion: created.secretVersion },
          }),
        );
        return ok(created);
      }),
    );
    return subscription.ok
      ? ok({
          subscription: subscription.value,
          secret: signer.secretFor(subscription.value.id, subscription.value.secretVersion),
        })
      : subscription;
  }
}
