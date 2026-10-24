import { Inject, Injectable } from '@nestjs/common';
import {
  err,
  ok,
  type Clock,
  type MarketContext,
  type Result,
  type Temporal,
} from '@mondapac-drive/shared-kernel';
import { CLOCK } from '../../../../platform/clock/clock.module';
import { UNIT_OF_WORK, type UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { unknownCourier, type PayoutsFailure } from '../failure';
import {
  PAYEE_DIRECTORY,
  PAYOUT_ACCOUNT_REPOSITORY,
  PAYOUT_GATEWAY,
  PAYOUT_SETTINGS,
  type GatewayRefusal,
  type PayeeDirectory,
  type PayoutAccountRepository,
  type PayoutGateway,
  type PayoutSettingsProvider,
} from '../ports';

export interface OnboardingLink {
  readonly url: string;
  readonly expiresAt: Temporal.Instant;
}

const providerFailure = (refusal: GatewayRefusal): PayoutsFailure => ({
  code: refusal.transient ? 'payouts.provider-unavailable' : 'payouts.provider-refused',
  message: 'The payment provider did not answer the request; try again later',
});

/**
 * Gives a contractor a link to the payment provider's hosted onboarding, where the provider
 * collects their identity and bank details. Drive stores only the connected account's id: it
 * creates the account on the first call (the idempotency key makes a retry answer the same
 * account) and a fresh short-lived link on every call. The courier route arrives with the
 * courier population (identity work package 2).
 */
@Injectable()
export class StartPayoutOnboarding {
  constructor(
    @Inject(PAYOUT_ACCOUNT_REPOSITORY) private readonly accounts: PayoutAccountRepository,
    @Inject(PAYEE_DIRECTORY) private readonly payees: PayeeDirectory,
    @Inject(PAYOUT_GATEWAY) private readonly gateway: PayoutGateway,
    @Inject(PAYOUT_SETTINGS) private readonly settings: PayoutSettingsProvider,
    @Inject(UNIT_OF_WORK) private readonly unitOfWork: UnitOfWork,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async run(
    market: MarketContext,
    courierId: string,
  ): Promise<Result<OnboardingLink, PayoutsFailure>> {
    if (!this.gateway.enabled) {
      return err({
        code: 'payouts.provider-unavailable',
        message: 'Payouts are not connected to a payment provider in this deployment',
      });
    }
    const settings = this.settings.get(market.marketId);
    const payee = (await this.payees.payees(market, [courierId])).get(courierId);
    if (payee === undefined) return err(unknownCourier(courierId));
    if (payee.engagement !== 'contractor') {
      return err({
        code: 'payouts.not-a-contractor',
        message: 'Employees are paid through payroll and need no payout account',
      });
    }

    const stored = await this.unitOfWork.run(
      market,
      async () => ok(await this.accounts.find(market, courierId)),
      { readOnly: true },
    );
    if (!stored.ok) return stored;
    let accountId = stored.value?.providerAccountId;
    if (accountId === undefined) {
      const created = await this.gateway.createAccount({
        country: settings.provider.accountCountry,
        idempotencyKey: `payout-account-${market.marketId}-${courierId}`,
        metadata: { marketId: market.marketId, courierId },
      });
      if (!created.ok) return err(providerFailure(created.error));
      const saved = await this.unitOfWork.run(market, async () => {
        const now = this.clock.now();
        const inserted = await this.accounts.insert(market, {
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
            : (await this.accounts.find(market, courierId))!.providerAccountId,
        );
      });
      if (!saved.ok) return saved;
      accountId = saved.value;
    }

    const link = await this.gateway.createOnboardingLink({
      accountId,
      returnUrl: settings.provider.onboardingReturnUrl,
      refreshUrl: settings.provider.onboardingRefreshUrl,
    });
    return link.ok ? ok(link.value) : err(providerFailure(link.error));
  }
}
