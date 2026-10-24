import {
  err,
  ok,
  type CallContext,
  type Clock,
  type MarketContext,
  type Result,
} from '@mondapac-drive/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { AuditWriter } from '../../../../platform/audit/audit-writer';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { WEBHOOK_MANAGE, WEBHOOK_VIEW } from '../../contracts/permissions';
import {
  WebhookDisabledAudit,
  WebhookEventTypesChangedAudit,
  WebhookSecretRotatedAudit,
} from '../../domain/audit';
import {
  changeEventTypes,
  disableSubscription,
  rotateSecret,
  type WebhookSubscription,
} from '../../domain/webhook-subscription';
import { ACCESS_DENIED, merchantOf } from '../callers';
import { notFound, refusingBrokenRules, type NotificationsFailure } from '../failure';
import type {
  NotificationSettingsProvider,
  WebhookSigner,
  WebhookSubscriptionRepository,
} from '../ports';
import { eventTypesOf, type SubscriptionWithSecret } from './subscribe-to-webhooks.use-case';

export interface SubscriptionRef {
  readonly subscriptionId: string;
}

export interface ChangeSubscriptionDependencies {
  readonly subscriptions: WebhookSubscriptionRepository;
  readonly signer: WebhookSigner;
  readonly settings: NotificationSettingsProvider;
  readonly audit: AuditWriter;
  readonly unitOfWork: UnitOfWork;
  readonly clock: Clock;
}

/**
 * Applies one step to a merchant's own subscription in one unit, with its audit row when it
 * changed; another merchant's subscription answers as a missing one.
 */
function changeOwnSubscription(
  deps: ChangeSubscriptionDependencies,
  context: CallContext,
  merchantId: string,
  subscriptionId: string,
  step: (subscription: WebhookSubscription) => WebhookSubscription,
  audited: (before: WebhookSubscription, after: WebhookSubscription) => Promise<void>,
): Promise<Result<WebhookSubscription, NotificationsFailure>> {
  const { market } = context;
  return deps.unitOfWork.run(market, () =>
    refusingBrokenRules(async () => {
      const found = await deps.subscriptions.findById(market, subscriptionId);
      if (found === undefined || found.merchantId !== merchantId) {
        return err(notFound('webhook-subscription'));
      }
      const next = step(found);
      if (next !== found) {
        await deps.subscriptions.update(market, next);
        await audited(found, next);
      }
      return ok(next);
    }),
  );
}

/**
 * The merchant rotates a subscription's secret and receives the new one, once. Rule
 * `permissions [notifications.webhook.manage]`. The previous secret keeps signing, next to the
 * new one, for the Market's rotation overlap. Audited.
 */
export class RotateWebhookSecret extends UseCase<
  SubscriptionRef,
  SubscriptionWithSecret,
  NotificationsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'notifications.rotate-webhook-secret',
    rule: { kind: 'permissions', allOf: [WEBHOOK_MANAGE.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: ChangeSubscriptionDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: SubscriptionRef,
  ): Promise<Result<SubscriptionWithSecret, NotificationsFailure>> {
    const merchantId = merchantOf(context);
    if (merchantId === null) return err(ACCESS_DENIED);
    const { settings, clock, audit, signer } = this.deps;
    const overlap = settings.get(context.market.marketId).rotationOverlapSeconds;
    const now = clock.now();
    const rotated = await changeOwnSubscription(
      this.deps,
      context,
      merchantId,
      input.subscriptionId,
      (subscription) => rotateSecret(subscription, now, overlap),
      (before, after) =>
        audit.record(
          context,
          WebhookSecretRotatedAudit.entry(after.id as never, {
            before: { secretVersion: before.secretVersion },
            after: {
              secretVersion: after.secretVersion,
              previousSecretValidUntil: after.previousSecretValidUntil,
            },
          }),
        ),
    );
    if (!rotated.ok) return rotated;
    const subscription = rotated.value;
    return ok({
      subscription,
      secret: signer.secretFor(subscription.id, subscription.secretVersion),
    });
  }
}

export interface ChangeEventTypesInput extends SubscriptionRef {
  readonly eventTypes: readonly string[];
}

/**
 * The merchant changes which delivery events a subscription receives. Rule `permissions
 * [notifications.webhook.manage]`. The URL never changes (a new URL is a new subscription, which
 * passes the SSRF guard again). Audited when the types change.
 */
export class ChangeWebhookEventTypes extends UseCase<
  ChangeEventTypesInput,
  WebhookSubscription,
  NotificationsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'notifications.change-webhook-event-types',
    rule: { kind: 'permissions', allOf: [WEBHOOK_MANAGE.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: ChangeSubscriptionDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: ChangeEventTypesInput,
  ): Promise<Result<WebhookSubscription, NotificationsFailure>> {
    const merchantId = merchantOf(context);
    if (merchantId === null) return Promise.resolve(err(ACCESS_DENIED));
    const eventTypes = eventTypesOf(input.eventTypes);
    if (!eventTypes.ok) return Promise.resolve(eventTypes);
    return changeOwnSubscription(
      this.deps,
      context,
      merchantId,
      input.subscriptionId,
      (subscription) => changeEventTypes(subscription, eventTypes.value),
      (before, after) =>
        this.deps.audit.record(
          context,
          WebhookEventTypesChangedAudit.entry(after.id as never, {
            before: { eventTypes: [...before.eventTypes] },
            after: { eventTypes: [...after.eventTypes] },
          }),
        ),
    );
  }
}

/**
 * The merchant disables a subscription: no new calls; queued ones die when they come due. Rule
 * `permissions [notifications.webhook.manage]`. Audited once; disabling again changes nothing.
 */
export class DisableWebhookSubscription extends UseCase<
  SubscriptionRef,
  WebhookSubscription,
  NotificationsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'notifications.disable-webhook-subscription',
    rule: { kind: 'permissions', allOf: [WEBHOOK_MANAGE.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: ChangeSubscriptionDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: SubscriptionRef,
  ): Promise<Result<WebhookSubscription, NotificationsFailure>> {
    const merchantId = merchantOf(context);
    if (merchantId === null) return Promise.resolve(err(ACCESS_DENIED));
    return changeOwnSubscription(
      this.deps,
      context,
      merchantId,
      input.subscriptionId,
      disableSubscription,
      (_before, after) =>
        this.deps.audit.record(
          context,
          WebhookDisabledAudit.entry(after.id as never, { after: { disabled: true } }),
        ),
    );
  }
}

/** Subscriptions one list answers. */
export const SUBSCRIPTION_LIST_LIMIT = 50;

export interface ListSubscriptionsDependencies {
  readonly subscriptions: WebhookSubscriptionRepository;
  readonly unitOfWork: UnitOfWork;
}

/**
 * The merchant's own subscriptions, active and disabled, newest first. Rule `permissions
 * [notifications.webhook.view]`. Never a secret.
 */
export class ListWebhookSubscriptions extends UseCase<
  Record<string, never>,
  WebhookSubscription[],
  NotificationsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'notifications.list-webhook-subscriptions',
    rule: { kind: 'permissions', allOf: [WEBHOOK_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: ListSubscriptionsDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
  ): Promise<Result<WebhookSubscription[], NotificationsFailure>> {
    const merchantId = merchantOf(context);
    if (merchantId === null) return Promise.resolve(err(ACCESS_DENIED));
    const market: MarketContext = context.market;
    return this.deps.unitOfWork.run(
      market,
      async () =>
        ok(await this.deps.subscriptions.listOf(market, merchantId, SUBSCRIPTION_LIST_LIMIT)),
      { readOnly: true },
    );
  }
}
