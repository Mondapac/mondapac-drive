import type { Clock, IdGenerator } from '@mondapac-drive/shared-kernel';
import type { AuditWriter } from '../../../platform/audit/audit-writer';
import type { OutboxWriter } from '../../../platform/events/outbox-writer';
import type { UnitOfWork } from '../../../platform/unit-of-work/unit-of-work';
import type {
  DeliveryFactsReader,
  LedgerRepository,
  PayeeDirectory,
  PayoutAccountRepository,
  PayoutGateway,
  PayoutRunRepository,
  PayoutSettingsProvider,
  ProviderWebhookVerifier,
} from './ports';

/**
 * The ports every payouts use case is built with (one object, so the module wires each use case
 * the same way). A use case reads only the ones it needs.
 */
export interface PayoutsDependencies {
  readonly ledger: LedgerRepository;
  readonly runs: PayoutRunRepository;
  readonly accounts: PayoutAccountRepository;
  readonly payees: PayeeDirectory;
  readonly deliveries: DeliveryFactsReader;
  readonly gateway: PayoutGateway;
  readonly verifier: ProviderWebhookVerifier;
  readonly settings: PayoutSettingsProvider;
  readonly unitOfWork: UnitOfWork;
  readonly outbox: OutboxWriter;
  readonly audit: AuditWriter;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}
