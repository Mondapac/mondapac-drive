import { Global, Module, type FactoryProvider } from '@nestjs/common';
import type { Clock, IdGenerator } from '@mondapac-drive/shared-kernel';
import { MODEL_MAP } from '../../generated/model-map';
import { AuditActionCatalogue } from '../audit/audit-action-catalogue';
import { AUDIT_CHAIN_STORE, type AuditChainStore } from '../audit/audit-chain-store';
import { AUDIT_TRAIL_READER, type AuditTrailReader } from '../audit/audit-trail-reader';
import { AUDIT_WRITER, type AuditWriter } from '../audit/audit-writer';
import { CLOCK } from '../clock/clock.module';
import type { AppConfig } from '../config/app-config';
import { APP_CONFIG } from '../config/config.module';
import { EVENT_BUS, OUTBOX_RELAY, type EventBus } from '../events/event-bus';
import { EventCatalogue } from '../events/event-catalogue';
import { EVENT_DISPATCHER } from '../events/event-delivery';
import { SubscriptionRegistry } from '../events/event-subscriptions';
import {
  OUTBOX_WRITER,
  PERMISSION_KEY_LOOKUP,
  type OutboxWriter,
  type PermissionKeyLookup,
} from '../events/outbox-writer';
import { ID_GENERATOR } from '../ids/ids.module';
import { MarketRegistry } from '../market-config/market-registry';
import { MarketContextFactory } from '../market-context/market-context.factory';
import { RATE_LIMIT_COUNTERS } from '../rate-limit/rate-limit-counters';
import { JOB_LOCK } from '../scheduler/job-lock';
import { SUBJECT_KEY_STORE, type SubjectKeyStore } from '../subject-keys/subject-key-store';
import { UNIT_OF_WORK, type UnitOfWork } from '../unit-of-work/unit-of-work';
import { AdvisoryJobLock } from './advisory-job-lock';
import { PrismaAuditChainStore } from './audit/prisma-audit-chain-store';
import { createAuditTrailReader } from './audit/prisma-audit-trail-reader';
import { createAuditWriter } from './audit/prisma-audit-writer';
import { DatabaseProbe } from './database-probe';
import { createGuardedClient, GUARDED_CLIENT, type GuardedClient } from './guarded-client';
import type { ModelMap } from './model-map';
import { InProcessEventBus } from './outbox/in-process-event-bus';
import { PrismaEventDispatcher } from './outbox/prisma-event-dispatcher';
import { PrismaOutboxRelay } from './outbox/prisma-outbox-relay';
import { PrismaOutboxWriterFactory } from './outbox/prisma-outbox-writer';
import { INBOX_PURGER, inboxRetentionJob, type InboxPurger } from '../events/inbox-retention';
import { registerJobsFrom } from '../scheduler/job-registry';
import { PrismaInboxPurger } from './outbox/prisma-inbox-purger';
import { PrismaRoot } from './prisma-root';
import { parseSql } from './raw-reads/pg-parser';
import { BIND_RAW_READ, RAW_READ_BASE, type RawReadBinder } from './raw-reads/prisma-raw-read-port';
import { createRawReadPort } from './raw-reads/create-raw-read-port';
import { RAW_READ_PORT, type RawReadPort } from './raw-reads/raw-read-port';
import { RAW_READ_STATEMENTS } from './raw-reads/statements';
import { PostgresRateLimitCounters } from './postgres-rate-limit-counters';
import { PrismaService } from './prisma.service';
import { PrismaSubjectKeyStore } from './prisma-subject-key-store';
import { PrismaUnitOfWork } from './prisma-unit-of-work';

/** The generated map, checked against the shape the guard reads. */
const modelMap: ModelMap = MODEL_MAP;

/**
 * Persistence (platform persistence design, "P", 3.3, 5 to 7). Exports the guarded door for
 * modules (`PrismaService`), the `UnitOfWork` port, `DatabaseProbe`, and the implementations
 * of the event, scheduler and rate-limit ports (relay, bus, job lock, rate-limit counters); never the base client
 * (`PrismaRoot`) or the guarded client, so Nest cannot inject them elsewhere. The outbox writer
 * factory is not a provider at all: a module reaches only its own writer, through
 * {@link PersistenceModule.outboxWriterFor}. A static method, not a named export, so this file
 * still exports only `PersistenceModule` (boundaries.spec.ts).
 */
@Global()
@Module({
  providers: [
    {
      provide: PrismaRoot,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => new PrismaRoot(config),
    },
    {
      provide: GUARDED_CLIENT,
      inject: [PrismaRoot],
      useFactory: (root: PrismaRoot) => createGuardedClient(root, modelMap),
    },
    PrismaService,
    {
      provide: UNIT_OF_WORK,
      inject: [GUARDED_CLIENT],
      useFactory: (client: GuardedClient) => new PrismaUnitOfWork(client, modelMap),
    },
    {
      // The list is re-checked with the same pure parse as `pnpm boundaries` before the port
      // exists, so the application refuses to start on a statement that breaks ADR-0030
      // decisions 2 to 5, or when the parser cannot load (decision 4).
      provide: RAW_READ_BASE,
      inject: [PrismaRoot],
      useFactory: async (root: PrismaRoot): Promise<RawReadBinder> => {
        const port = await createRawReadPort(root, {
          parse: parseSql,
          list: RAW_READ_STATEMENTS,
          map: modelMap,
        });
        return { [BIND_RAW_READ]: (module) => port.forModule(module) };
      },
    },
    {
      provide: DatabaseProbe,
      inject: [PrismaRoot],
      useFactory: (root: PrismaRoot) => new DatabaseProbe(root),
    },
    {
      provide: EVENT_BUS,
      inject: [SubscriptionRegistry, CLOCK],
      useFactory: (subscriptions: SubscriptionRegistry, clock: Clock) =>
        new InProcessEventBus(subscriptions, clock),
    },
    {
      provide: EVENT_DISPATCHER,
      inject: [PrismaRoot, MarketRegistry, MarketContextFactory, SubscriptionRegistry, CLOCK],
      useFactory: (
        root: PrismaRoot,
        markets: MarketRegistry,
        contexts: MarketContextFactory,
        subscriptions: SubscriptionRegistry,
        clock: Clock,
      ) => new PrismaEventDispatcher(root, markets, contexts, subscriptions, clock),
    },
    {
      provide: OUTBOX_RELAY,
      inject: [PrismaRoot, MarketRegistry, MarketContextFactory, EVENT_BUS, CLOCK],
      useFactory: (
        root: PrismaRoot,
        markets: MarketRegistry,
        contexts: MarketContextFactory,
        bus: EventBus,
        clock: Clock,
      ) => new PrismaOutboxRelay(root, modelMap, markets, contexts, bus, clock),
    },
    {
      provide: INBOX_PURGER,
      inject: [PrismaRoot],
      useFactory: (root: PrismaRoot) => new PrismaInboxPurger(root, modelMap),
    },
    // Handoff 35: the platform's inbox retention, here because the purger is not exported.
    registerJobsFrom(
      'platform',
      [INBOX_PURGER, MarketRegistry, CLOCK],
      (purger: InboxPurger, markets: MarketRegistry, clock: Clock) => [
        inboxRetentionJob(purger, markets, clock),
      ],
    ),
    {
      provide: JOB_LOCK,
      inject: [PrismaRoot],
      useFactory: (root: PrismaRoot) => new AdvisoryJobLock(root),
    },
    {
      provide: RATE_LIMIT_COUNTERS,
      inject: [PrismaRoot, CLOCK],
      useFactory: (root: PrismaRoot, clock: Clock) => new PostgresRateLimitCounters(root, clock),
    },
  ],
  exports: [
    PrismaService,
    UNIT_OF_WORK,
    DatabaseProbe,
    RAW_READ_BASE,
    EVENT_BUS,
    OUTBOX_RELAY,
    EVENT_DISPATCHER,
    JOB_LOCK,
    RATE_LIMIT_COUNTERS,
  ],
})
export class PersistenceModule {
  /**
   * The one line of a module's Nest module that binds its own raw read port (ADR-0030, Hassan
   * R-1): `providers: [PersistenceModule.rawReadFor('certification')]`. The port answers only
   * the statements the module owns; any other id is refused as `wrong-module` at run time. The
   * unbound port is never exported, so a module cannot inject it.
   */
  static rawReadFor(module: string): FactoryProvider<RawReadPort> {
    if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(module)) {
      throw new Error(`"${module}" is not a module name`);
    }
    return {
      provide: RAW_READ_PORT,
      inject: [RAW_READ_BASE],
      useFactory: (base: RawReadBinder) => base[BIND_RAW_READ](module),
    };
  }

  /**
   * The one line of a module's Nest module that binds its own outbox writer (P 5.2):
   * `providers: [PersistenceModule.outboxWriterFor('identity')]`. The name is the module's
   * folder; the contracts test checks it for every module. The writer is built here from the exported door
   * (`PrismaService`) and the global catalogue, id generator and permission-key lookup, so no
   * module-to-writer factory is ever injectable: a module cannot resolve the factory or another
   * module's writer (security review of slice 1b, M1). A module never exports `OUTBOX_WRITER`.
   */
  static outboxWriterFor(module: string): FactoryProvider<OutboxWriter> {
    return {
      provide: OUTBOX_WRITER,
      inject: [PrismaService, EventCatalogue, ID_GENERATOR, PERMISSION_KEY_LOOKUP],
      useFactory: (
        prisma: PrismaService,
        catalogue: EventCatalogue,
        ids: IdGenerator,
        permissionKeys: PermissionKeyLookup,
      ) =>
        new PrismaOutboxWriterFactory(modelMap, prisma, catalogue, ids, permissionKeys).forModule(
          module,
        ),
    };
  }

  /**
   * The one line of a module's Nest module that binds its own audit writer
   * (docs/design/domain/platform-audit.md 2, 3.1): `providers: [PersistenceModule.auditWriterFor('identity')]`.
   * The owner is the module's folder, or `platform.<component>` for a platform component. As
   * with the outbox writer, no factory is injectable and a module never exports
   * `AUDIT_WRITER`. Identity slice 6b binds it into identity; the contracts test checks that
   * each binding names the folder it is declared in.
   */
  static auditWriterFor(owner: string): FactoryProvider<AuditWriter> {
    if (!/^(?:platform\.)?[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(owner) || owner === 'platform') {
      throw new Error(`"${owner}" is not a module name or "platform.<component>"`);
    }
    return {
      provide: AUDIT_WRITER,
      inject: [AuditActionCatalogue, ID_GENERATOR, CLOCK, PERMISSION_KEY_LOOKUP],
      useFactory: (
        catalogue: AuditActionCatalogue,
        ids: IdGenerator,
        clock: Clock,
        permissionKeys: PermissionKeyLookup,
      ) => createAuditWriter(owner, { catalogue, ids, clock, permissionKeys }),
    };
  }

  /**
   * A module's own audit history reader (docs/design/domain/platform-audit.md 10), bound the way
   * {@link PersistenceModule.auditWriterFor} binds the writer: `providers:
   * [PersistenceModule.auditTrailReaderFor('sellers')]`. It reads only the owner's own actions;
   * no factory is injectable and a module never exports `AUDIT_TRAIL_READER`.
   */
  static auditTrailReaderFor(owner: string): FactoryProvider<AuditTrailReader> {
    if (!/^(?:platform\.)?[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(owner) || owner === 'platform') {
      throw new Error(`"${owner}" is not a module name or "platform.<component>"`);
    }
    return {
      provide: AUDIT_TRAIL_READER,
      inject: [AuditActionCatalogue],
      useFactory: (catalogue: AuditActionCatalogue) => createAuditTrailReader(owner, catalogue),
    };
  }

  /**
   * The chain tables of the audit (docs/design/domain/platform-audit.md 7, 8), bound only by
   * `AuditModule` for the sealer and the verifier: the store is not exported, so no module
   * reads or writes the chain (PA 2). Its statements run in the caller's unit through
   * `auditTx`, like the writer's.
   */
  static auditChainStore(): FactoryProvider<AuditChainStore> {
    return { provide: AUDIT_CHAIN_STORE, useFactory: () => new PrismaAuditChainStore() };
  }

  /**
   * The key table of the SubjectKeyService (foundations 4, row 13), bound only by
   * `SubjectKeysModule`: the store is not exported, so no module can read wrapped keys past
   * the service.
   */
  static subjectKeyStore(): FactoryProvider<SubjectKeyStore> {
    return {
      provide: SUBJECT_KEY_STORE,
      inject: [PrismaService, UNIT_OF_WORK],
      useFactory: (prisma: PrismaService, unitOfWork: UnitOfWork) =>
        new PrismaSubjectKeyStore(prisma, unitOfWork),
    };
  }
}
