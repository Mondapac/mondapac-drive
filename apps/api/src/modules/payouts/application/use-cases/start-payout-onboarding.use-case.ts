import { err, ok, type CallContext, type Result, type Temporal } from '@mondapac-drive/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { ACCOUNT_ONBOARD } from '../../contracts/permissions';
import { courierOf } from '../callers';
import type { PayoutsDependencies } from '../dependencies';
import { ACCESS_DENIED, unknownCourier, type PayoutsFailure } from '../failure';
import type { GatewayRefusal } from '../ports';

export interface OnboardingLink {
  readonly url: string;
  readonly expiresAt: Temporal.Instant;
}

const providerFailure = (refusal: GatewayRefusal): PayoutsFailure => ({
  code: refusal.transient ? 'payouts.provider-unavailable' : 'payouts.provider-refused',
  message: 'The payment provider did not answer the request; try again later',
});

/**
 * Gives the signed-in contractor a link to the payment provider's hosted onboarding, where the
 * provider collects their identity and bank details. Drive stores only the connected account's
 * id: it creates the account on the first call (the idempotency key makes a retry answer the
 * same account) and a fresh short-lived link on every call. Rule
 * `permissions [payouts.account.onboard]`, couriers only; the courier is the session's account.
 */
export class StartPayoutOnboarding extends UseCase<
  Record<string, never>,
  OnboardingLink,
  PayoutsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'payouts.start-payout-onboarding',
    rule: { kind: 'permissions', allOf: [ACCOUNT_ONBOARD.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: PayoutsDependencies,
  ) {
    super(gate);
  }

  protected async handle(context: CallContext): Promise<Result<OnboardingLink, PayoutsFailure>> {
    const courierId = courierOf(context);
    if (courierId === null) return err(ACCESS_DENIED);
    const { market } = context;
    const { accounts, payees, gateway, unitOfWork, clock } = this.deps;
    if (!gateway.enabled) {
      return err({
        code: 'payouts.provider-unavailable',
        message: 'Payouts are not connected to a payment provider in this deployment',
      });
    }
    const settings = this.deps.settings.get(market.marketId);
    const payee = (await payees.payees(context, [courierId])).get(courierId);
    if (payee === undefined) return err(unknownCourier(courierId));
    if (payee.engagement !== 'contractor') {
      return err({
        code: 'payouts.not-a-contractor',
        message: 'Employees are paid through payroll and need no payout account',
      });
    }

    const stored = await unitOfWork.run(
      market,
      async () => ok(await accounts.find(market, courierId)),
      { readOnly: true },
    );
    if (!stored.ok) return stored;
    let accountId = stored.value?.providerAccountId;
    if (accountId === undefined) {
      const created = await gateway.createAccount({
        country: settings.provider.accountCountry,
        idempotencyKey: `payout-account-${market.marketId}-${market.tenantId}-${courierId}`,
        metadata: { marketId: market.marketId, courierId },
      });
      if (!created.ok) return err(providerFailure(created.error));
      const saved = await unitOfWork.run(market, async () => {
        const now = clock.now();
        const inserted = await accounts.insert(market, {
          courierId,
          providerAccountId: created.value.accountId,
          payoutsEnabled: false,
          createdAt: now,
          updatedAt: now,
        });
        // A concurrent call stored its account first: keep that one.
        return ok(
          inserted
            ? created.value.accountId
            : (await accounts.find(market, courierId))!.providerAccountId,
        );
      });
      if (!saved.ok) return saved;
      accountId = saved.value;
    }

    const link = await gateway.createOnboardingLink({
      accountId,
      returnUrl: settings.provider.onboardingReturnUrl,
      refreshUrl: settings.provider.onboardingRefreshUrl,
    });
    return link.ok ? ok(link.value) : err(providerFailure(link.error));
  }
}
