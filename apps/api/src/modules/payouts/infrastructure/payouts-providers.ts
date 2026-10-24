import type { Provider } from '@nestjs/common';
import type { AppConfig } from '../../../platform/config/app-config';
import { APP_CONFIG } from '../../../platform/config/config.module';
import { MarketRegistry } from '../../../platform/market-config/market-registry';
import { PrismaService } from '../../../platform/persistence/prisma.service';
import {
  DELIVERY_FACTS,
  LEDGER_REPOSITORY,
  PAYEE_DIRECTORY,
  PAYOUT_ACCOUNT_REPOSITORY,
  PAYOUT_GATEWAY,
  PAYOUT_RUN_REPOSITORY,
  PAYOUT_SETTINGS,
  PROVIDER_WEBHOOK_VERIFIER,
} from '../application/ports';
import { ConfigPayoutSettingsProvider } from './config-payout-settings.provider';
import { InMemoryPayeeDirectory } from './in-memory-payee-directory';
import { PrismaLedgerRepository } from './prisma-ledger.repository';
import { PrismaPayoutAccountRepository } from './prisma-payout-accounts.repository';
import { PrismaPayoutRunRepository } from './prisma-payout-runs.repository';
import { DisabledPayoutGateway, StripePayoutGateway } from './stripe-payout-gateway';
import { StripeWebhookVerifier } from './stripe-webhook-verifier';
import { UnwiredDeliveryFacts } from './unwired-delivery-facts';

/** The implementations of the payouts ports. Only infrastructure/ reaches the persistence internals. */
export const payoutsProviders: Provider[] = [
  {
    provide: LEDGER_REPOSITORY,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService) => new PrismaLedgerRepository(prisma),
  },
  {
    provide: PAYOUT_RUN_REPOSITORY,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService) => new PrismaPayoutRunRepository(prisma),
  },
  {
    provide: PAYOUT_ACCOUNT_REPOSITORY,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService) => new PrismaPayoutAccountRepository(prisma),
  },
  {
    provide: PAYOUT_SETTINGS,
    inject: [MarketRegistry],
    useFactory: (markets: MarketRegistry) => new ConfigPayoutSettingsProvider(markets),
  },
  // Until fleet's payee profiles (work package 23) are on main: no courier is known, so nothing
  // is paid.
  { provide: PAYEE_DIRECTORY, useFactory: () => new InMemoryPayeeDirectory() },
  { provide: DELIVERY_FACTS, useFactory: () => new UnwiredDeliveryFacts() },
  {
    provide: PAYOUT_GATEWAY,
    inject: [APP_CONFIG],
    useFactory: (config: AppConfig) =>
      config.paymentProvider === null
        ? new DisabledPayoutGateway()
        : new StripePayoutGateway(config.paymentProvider.secretKey),
  },
  {
    provide: PROVIDER_WEBHOOK_VERIFIER,
    inject: [APP_CONFIG],
    useFactory: (config: AppConfig) =>
      new StripeWebhookVerifier(config.paymentProvider?.webhookSecrets ?? []),
  },
];
