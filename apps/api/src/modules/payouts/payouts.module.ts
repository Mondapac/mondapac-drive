import { Module, type FactoryProvider } from '@nestjs/common';
import type { Clock, IdGenerator } from '@mondapac-drive/shared-kernel';
import { registerAuditActions } from '../../platform/audit/audit-action-catalogue';
import { AUDIT_WRITER, type AuditWriter } from '../../platform/audit/audit-writer';
import { registerPermissions, USE_CASE_GATE, type UseCaseGate } from '../../platform/authz';
import { CLOCK } from '../../platform/clock/clock.module';
import { registerEvents } from '../../platform/events/event-catalogue';
import { registerSubscriptionsFrom } from '../../platform/events/event-subscriptions';
import { OUTBOX_WRITER, type OutboxWriter } from '../../platform/events/outbox-writer';
import { ID_GENERATOR } from '../../platform/ids/ids.module';
import { PersistenceModule } from '../../platform/persistence/persistence.module';
import { DeliveryModule } from '../delivery';
import { FleetModule } from '../fleet';
import { registerJobsFrom } from '../../platform/scheduler/job-registry';
import { UNIT_OF_WORK, type UnitOfWork } from '../../platform/unit-of-work/unit-of-work';
import type { PayoutsDependencies } from './application/dependencies';
import {
  DELIVERY_FACTS,
  LEDGER_REPOSITORY,
  PAYEE_DIRECTORY,
  PAYOUT_ACCOUNT_REPOSITORY,
  PAYOUT_GATEWAY,
  PAYOUT_RUN_REPOSITORY,
  PAYOUT_SETTINGS,
  PROVIDER_WEBHOOK_VERIFIER,
  type DeliveryFactsReader,
  type LedgerRepository,
  type PayeeDirectory,
  type PayoutAccountRepository,
  type PayoutGateway,
  type PayoutRunRepository,
  type PayoutSettingsProvider,
  type ProviderWebhookVerifier,
} from './application/ports';
import {
  GetCourierBalance,
  GetEarningsSummary,
  ViewCourierBalance,
} from './application/use-cases/get-courier-balance.use-case';
import { HandleProviderWebhook } from './application/use-cases/handle-provider-webhook.use-case';
import { ListPayoutLines } from './application/use-cases/list-payout-lines.use-case';
import { EarningsQuote } from './application/use-cases/quote-offer-earning.use-case';
import { RecordAdjustment } from './application/use-cases/record-adjustment.use-case';
import { RecordDeliveryEarning } from './application/use-cases/record-delivery-earning.use-case';
import { RecordTip } from './application/use-cases/record-tip.use-case';
import { ReverseDeliveryEarning } from './application/use-cases/reverse-delivery-earning.use-case';
import { RunPayouts } from './application/use-cases/run-payouts.use-case';
import { SettleUnresolvedLine } from './application/use-cases/settle-unresolved-line.use-case';
import { StartPayoutOnboarding } from './application/use-cases/start-payout-onboarding.use-case';
import { PAYOUTS_PERMISSIONS } from './contracts/permissions';
import { PAYOUTS_AUDIT_ACTIONS } from './domain/audit-actions';
import { PAYOUTS_EVENTS } from './domain/events';
import { payoutsProviders } from './infrastructure/payouts-providers';
import { AdminPayoutsController } from './presentation/admin-payouts.controller';
import { CourierPayoutsController } from './presentation/courier-payouts.controller';
import { payoutJob } from './presentation/jobs/payout-jobs';
import { ProviderWebhookController } from './presentation/provider-webhook.controller';
import { deliveryEarningSubscriptions } from './presentation/subscribers/delivery-earning.subscriptions';

/** The ports of {@link PayoutsDependencies}, in the order the factory receives them. */
const DEPENDENCY_TOKENS = [
  LEDGER_REPOSITORY,
  PAYOUT_RUN_REPOSITORY,
  PAYOUT_ACCOUNT_REPOSITORY,
  PAYEE_DIRECTORY,
  DELIVERY_FACTS,
  PAYOUT_GATEWAY,
  PROVIDER_WEBHOOK_VERIFIER,
  PAYOUT_SETTINGS,
  UNIT_OF_WORK,
  OUTBOX_WRITER,
  AUDIT_WRITER,
  CLOCK,
  ID_GENERATOR,
];

/** The provider of one use case: the gate and every payouts port. */
function useCase<U>(
  type: new (gate: UseCaseGate, deps: PayoutsDependencies) => U,
): FactoryProvider<U> {
  return {
    provide: type,
    inject: [USE_CASE_GATE, ...DEPENDENCY_TOKENS],
    useFactory: (
      gate: UseCaseGate,
      ledger: LedgerRepository,
      runs: PayoutRunRepository,
      accounts: PayoutAccountRepository,
      payees: PayeeDirectory,
      deliveries: DeliveryFactsReader,
      gateway: PayoutGateway,
      verifier: ProviderWebhookVerifier,
      settings: PayoutSettingsProvider,
      unitOfWork: UnitOfWork,
      outbox: OutboxWriter,
      audit: AuditWriter,
      clock: Clock,
      ids: IdGenerator,
    ) =>
      new type(gate, {
        ledger,
        runs,
        accounts,
        payees,
        deliveries,
        gateway,
        verifier,
        settings,
        unitOfWork,
        outbox,
        audit,
        clock,
        ids,
      }),
  };
}

/**
 * Payouts: what couriers earn per delivery under each Market's rules, an append-only ledger of
 * earnings, tips, adjustments, payouts and reversals, and the payout runs that transfer
 * contractor balances to their Stripe Connect accounts. Every entry goes through a use case
 * behind the UseCaseGate: couriers read their own earnings and onboard their payout account,
 * operators read lines and balances and (with protected keys, audited) adjust balances and
 * settle unresolved lines; the payout job and the delivery subscriber run as the system actor,
 * and the provider's webhook is anonymous behind its signature.
 */
@Module({
  imports: [DeliveryModule, FleetModule],
  controllers: [ProviderWebhookController, CourierPayoutsController, AdminPayoutsController],
  providers: [
    registerPermissions('payouts', PAYOUTS_PERMISSIONS),
    registerEvents('payouts', PAYOUTS_EVENTS),
    registerAuditActions('payouts', PAYOUTS_AUDIT_ACTIONS),
    PersistenceModule.outboxWriterFor('payouts'),
    PersistenceModule.auditWriterFor('payouts'),
    ...payoutsProviders,
    useCase(RecordDeliveryEarning),
    useCase(RecordTip),
    useCase(RecordAdjustment),
    useCase(ReverseDeliveryEarning),
    useCase(GetCourierBalance),
    useCase(GetEarningsSummary),
    useCase(ViewCourierBalance),
    useCase(ListPayoutLines),
    useCase(RunPayouts),
    useCase(SettleUnresolvedLine),
    useCase(StartPayoutOnboarding),
    useCase(HandleProviderWebhook),
    useCase(EarningsQuote),
    registerJobsFrom('payouts', [RunPayouts], (run: RunPayouts) => [payoutJob(run)]),
    registerSubscriptionsFrom('payouts', [RecordDeliveryEarning], (record: RecordDeliveryEarning) =>
      deliveryEarningSubscriptions(record),
    ),
  ],
  exports: [EarningsQuote],
})
export class PayoutsModule {}
