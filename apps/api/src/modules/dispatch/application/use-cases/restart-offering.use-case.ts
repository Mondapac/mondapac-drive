import {
  err,
  ok,
  parseId,
  type CallContext,
  type Clock,
  type Result,
} from '@mondapac-drive/shared-kernel';
import type { AuditWriter } from '../../../../platform/audit/audit-writer';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { JOB_ASSIGN } from '../../contracts/permissions';
import { offeringRestartedAudit, statusCode } from '../../domain/audit-actions';
import { restartOffering, type DispatchJob } from '../../domain/dispatch-job';
import { isAdmin } from '../callers';
import { accessDenied, jobNotFound, refusingBrokenRules, type DispatchFailure } from '../failure';
import type { DispatchJobRepository } from '../ports';

export interface RestartOfferingInput {
  /** The delivery's id as the route received it: checked here. */
  readonly deliveryId: string;
}

export interface RestartOfferingDependencies {
  readonly jobs: DispatchJobRepository;
  readonly audit: AuditWriter;
  readonly unitOfWork: UnitOfWork;
  readonly clock: Clock;
}

/**
 * A dispatcher dispatches a delivery again after every round went unanswered: offering restarts
 * with fresh rounds, and the next sweep (within seconds) sends the first wave. Couriers who
 * declined or dropped it are still skipped. Taking a delivery off its courier is the delivery's
 * own unassign route; dispatch follows it from `delivery.status-changed`. Audited. Rule
 * `permissions [dispatch.job.assign]`, admins only.
 */
export class RestartOffering extends UseCase<RestartOfferingInput, DispatchJob, DispatchFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'dispatch.restart-offering',
    rule: { kind: 'permissions', allOf: [JOB_ASSIGN.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: RestartOfferingDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: RestartOfferingInput,
  ): Promise<Result<DispatchJob, DispatchFailure>> {
    if (!isAdmin(context)) return err(accessDenied());
    const deliveryId = parseId<'Delivery'>(input.deliveryId);
    if (!deliveryId.ok) return err(jobNotFound());
    const { jobs, audit, unitOfWork, clock } = this.deps;
    const { market } = context;
    return unitOfWork.run(market, () =>
      refusingBrokenRules(async () => {
        const job = await jobs.findByDelivery(market, deliveryId.value);
        if (job === undefined) return err(jobNotFound());
        const change = restartOffering(job, clock.now());
        await jobs.update(market, change.job);
        await audit.record(
          context,
          offeringRestartedAudit.entry(job.id, {
            before: { status: statusCode(job.status) },
            after: { status: statusCode(change.job.status) },
          }),
        );
        return ok(change.job);
      }),
    );
  }
}
