import { Global, Module } from '@nestjs/common';
import type { Clock } from '@mondapac-drive/shared-kernel';
import { CLOCK } from '../clock/clock.module';
import { PersistenceModule } from '../persistence/persistence.module';
import { registerJobsFrom } from '../scheduler/job-registry';
import { UNIT_OF_WORK, type UnitOfWork } from '../unit-of-work/unit-of-work';
import { AuditActionCatalogue } from './audit-action-catalogue';
import { AUDIT_CHAIN_STORE, type AuditChainStore } from './audit-chain-store';
import { auditSealJob, auditVerifyJob } from './audit-jobs';
import { AuditSealer } from './audit-sealer';
import { AuditVerifier } from './audit-verifier';
import {
  ANCHOR_SINK,
  ANCHOR_SOURCE,
  LogAnchorSink,
  type AnchorSink,
  type AnchorSource,
} from './anchor-sink';

/**
 * The audit (docs/design/domain/platform-audit.md 2): the action catalogue every module and
 * platform component registers with; the sealer and the verifier with their jobs
 * `platform.audit-seal` and `platform.audit-verify` (the worker runs them; both roles build
 * them); the Phase 2 log anchor. The writer is implemented by the persistence module
 * (`platform/persistence/audit/`) and bound per module with `PersistenceModule.auditWriterFor`;
 * there is no injectable writer factory. The chain store is bound here only and not exported,
 * so no module reads the chain tables.
 */
@Global()
@Module({
  providers: [
    AuditActionCatalogue,
    PersistenceModule.auditChainStore(),
    { provide: ANCHOR_SINK, useFactory: (): AnchorSink => new LogAnchorSink() },
    {
      provide: AuditSealer,
      inject: [UNIT_OF_WORK, AUDIT_CHAIN_STORE, ANCHOR_SINK, CLOCK],
      useFactory: (
        unitOfWork: UnitOfWork,
        store: AuditChainStore,
        anchors: AnchorSink,
        clock: Clock,
      ) => new AuditSealer(unitOfWork, store, anchors, clock),
    },
    {
      provide: AuditVerifier,
      inject: [UNIT_OF_WORK, AUDIT_CHAIN_STORE, CLOCK, { token: ANCHOR_SOURCE, optional: true }],
      useFactory: (
        unitOfWork: UnitOfWork,
        store: AuditChainStore,
        clock: Clock,
        source: AnchorSource | undefined,
      ) => new AuditVerifier(unitOfWork, store, clock, source ?? null),
    },
    registerJobsFrom(
      'platform',
      [AuditSealer, AuditVerifier, CLOCK],
      (sealer: AuditSealer, verifier: AuditVerifier, clock: Clock) => [
        auditSealJob(sealer),
        auditVerifyJob(verifier, clock),
      ],
    ),
  ],
  exports: [AuditActionCatalogue],
})
export class AuditModule {}
