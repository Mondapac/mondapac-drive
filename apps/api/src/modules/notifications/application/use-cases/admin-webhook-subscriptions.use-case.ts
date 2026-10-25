import { err, ok, type CallContext, type Result } from '@mondapac-drive/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { WEBHOOK_SUBSCRIPTION_VIEW } from '../../contracts/permissions';
import type { WebhookSubscription } from '../../domain/webhook-subscription';
import { ACCESS_DENIED, isAdmin } from '../callers';
import type { NotificationsFailure } from '../failure';
import type { WebhookSubscriptionRepository } from '../ports';

/** The most subscriptions one page answers, and the default. */
export const MAX_SUBSCRIPTION_PAGE = 100;
export const DEFAULT_SUBSCRIPTION_PAGE = 50;

export interface SubscriptionPageInput {
  readonly merchantId?: string;
  /** The id of the last subscription of the previous page. */
  readonly after?: string;
  readonly limit?: number;
}

export interface SubscriptionPage {
  readonly items: readonly WebhookSubscription[];
  /** The `after` of the next page, or null on the last one. */
  readonly next: string | null;
}

/**
 * An operator browses the Market's merchant webhook subscriptions, of one merchant or of all,
 * newest first, a page at a time: the URL, event types, status and secret version, never a
 * secret (secrets are derived and never stored). Rule `permissions
 * [notifications.webhook-subscription.view]`, admins only. A read, not audited.
 */
export class ListAllWebhookSubscriptions extends UseCase<
  SubscriptionPageInput,
  SubscriptionPage,
  NotificationsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'notifications.list-all-webhook-subscriptions',
    rule: { kind: 'permissions', allOf: [WEBHOOK_SUBSCRIPTION_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: {
      readonly subscriptions: WebhookSubscriptionRepository;
      readonly unitOfWork: UnitOfWork;
    },
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: SubscriptionPageInput,
  ): Promise<Result<SubscriptionPage, NotificationsFailure>> {
    if (!isAdmin(context)) return err(ACCESS_DENIED);
    const limit = input.limit ?? DEFAULT_SUBSCRIPTION_PAGE;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_SUBSCRIPTION_PAGE) {
      return err({ code: 'webhook-subscription.page-limit', message: 'limit is 1 to 100' });
    }
    const { market } = context;
    const filter = {
      ...(input.merchantId === undefined ? {} : { merchantId: input.merchantId }),
      ...(input.after === undefined ? {} : { after: input.after }),
    };
    const found = await this.deps.unitOfWork.run(
      market,
      async () => ok(await this.deps.subscriptions.page(market, filter, limit + 1)),
      { readOnly: true },
    );
    if (!found.ok) return found;
    const items = found.value.slice(0, limit);
    const next = found.value.length > limit ? (items[items.length - 1]?.id ?? null) : null;
    return ok({ items, next });
  }
}
