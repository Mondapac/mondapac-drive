import { Module } from '@nestjs/common';
import { registerJobsFrom } from '../../platform/scheduler/job-registry';
import { GetCourierBalance } from './application/use-cases/get-courier-balance.use-case';
import { HandleProviderWebhook } from './application/use-cases/handle-provider-webhook.use-case';
import { RecordAdjustment } from './application/use-cases/record-adjustment.use-case';
import { RecordDeliveryEarning } from './application/use-cases/record-delivery-earning.use-case';
import { RecordTip } from './application/use-cases/record-tip.use-case';
import { ReverseDeliveryEarning } from './application/use-cases/reverse-delivery-earning.use-case';
import { RunPayouts } from './application/use-cases/run-payouts.use-case';
import { StartPayoutOnboarding } from './application/use-cases/start-payout-onboarding.use-case';
import { payoutsProviders } from './infrastructure/payouts-providers';
import { payoutJob } from './presentation/jobs/payout-jobs';
import { ProviderWebhookController } from './presentation/provider-webhook.controller';

/**
 * Payouts: what couriers earn per delivery under each Market's rules, an append-only ledger of
 * earnings, tips, adjustments, payouts and reversals, and the payout runs that transfer
 * contractor balances to their Stripe Connect accounts. Courier and operator routes arrive with
 * identity (work package 2); until then the use cases are reached by the job, the provider
 * webhook and, later, the delivery events.
 */
@Module({
  controllers: [ProviderWebhookController],
  providers: [
    RecordDeliveryEarning,
    RecordTip,
    RecordAdjustment,
    ReverseDeliveryEarning,
    GetCourierBalance,
    RunPayouts,
    StartPayoutOnboarding,
    HandleProviderWebhook,
    ...payoutsProviders,
    registerJobsFrom('payouts', [RunPayouts], (run: RunPayouts) => [payoutJob(run)]),
  ],
})
export class PayoutsModule {}
