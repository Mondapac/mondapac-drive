import {
  err,
  ok,
  parseId,
  type CallContext,
  type Clock,
  type Id,
  type Result,
} from '@mondapac-drive/shared-kernel';
import type { AuditWriter } from '../../../../platform/audit/audit-writer';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { OutboxWriter } from '../../../../platform/events/outbox-writer';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { JOB_ASSIGN } from '../../contracts/permissions';
import { courierAssignedAudit, statusCode } from '../../domain/audit-actions';
import type { VehicleType } from '../../domain/courier';
import { assignManually, type DispatchJob } from '../../domain/dispatch-job';
import { isAdmin } from '../callers';
import { accessDenied, jobNotFound, refusingBrokenRules, type DispatchFailure } from '../failure';
import type { CourierAccounts, DispatchJobRepository } from '../ports';

export interface AssignCourierInput {
  /** The ids as the route received them: checked here. */
  readonly deliveryId: string;
  readonly courierId: string;
  readonly vehicle: VehicleType;
}

export interface AssignCourierDependencies {
  readonly jobs: DispatchJobRepository;
  readonly couriers: CourierAccounts;
  readonly outbox: OutboxWriter;
  readonly audit: AuditWriter;
  readonly unitOfWork: UnitOfWork;
  readonly clock: Clock;
}

const courierNotActive = (): DispatchFailure => ({
  code: 'dispatch.courier-not-active',
  message: 'The courier is not an active courier of this Market',
});

/**
 * A dispatcher assigns a delivery to a courier, or replaces the assigned courier: while offers
 * are out (they are withdrawn), after every round lapsed, or before a scheduled job opened.
 * The courier must be an active courier account of the Market, asked as the dispatcher (their
 * role needs the courier view). Publishes `dispatch.courier-assigned` (the delivery records it)
 * and writes an audit row naming the dispatcher. Rule `permissions [dispatch.job.assign]`,
 * admins only.
 */
export class AssignCourier extends UseCase<AssignCourierInput, DispatchJob, DispatchFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'dispatch.assign-courier',
    rule: { kind: 'permissions', allOf: [JOB_ASSIGN.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: AssignCourierDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: AssignCourierInput,
  ): Promise<Result<DispatchJob, DispatchFailure>> {
    if (!isAdmin(context)) return err(accessDenied());
    const deliveryId = parseId<'Delivery'>(input.deliveryId);
    if (!deliveryId.ok) return err(jobNotFound());
    const courierId = parseId<'Courier'>(input.courierId);
    if (!courierId.ok) return err(courierNotActive());
    const { jobs, couriers, outbox, audit, unitOfWork, clock } = this.deps;
    const active = await couriers.isActive(context, courierId.value);
    if (active === undefined) return err(accessDenied());
    if (!active) return err(courierNotActive());

    const { market } = context;
    return unitOfWork.run(market, () =>
      refusingBrokenRules(async () => {
        const job = await jobs.findByDelivery(market, deliveryId.value);
        if (job === undefined) return err(jobNotFound());
        const change = assignManually(job, courierId.value, input.vehicle, clock.now());
        await jobs.update(market, change.job);
        await outbox.append(context, change.events);
        await audit.record(
          context,
          courierAssignedAudit.entry(job.id, {
            before: {
              status: statusCode(job.status),
              courierId: (job.assignment?.courierId as Id | undefined) ?? null,
            },
            after: {
              status: statusCode(change.job.status),
              courierId: courierId.value,
              vehicle: input.vehicle,
            },
          }),
        );
        return ok(change.job);
      }),
    );
  }
}
