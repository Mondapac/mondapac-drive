import { err, ok, parseId, type CallContext, type Result } from '@mondapac-drive/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { JOB_VIEW } from '../../contracts/permissions';
import type { DispatchJob } from '../../domain/dispatch-job';
import { isAdmin } from '../callers';
import { accessDenied, jobNotFound, type DispatchFailure } from '../failure';
import type { DispatchJobRepository } from '../ports';

export interface ViewDispatchJobInput {
  /** The delivery's id as the route received it: checked here. */
  readonly deliveryId: string;
}

export interface ViewDispatchJobDependencies {
  readonly jobs: DispatchJobRepository;
  readonly unitOfWork: UnitOfWork;
}

/**
 * A delivery's dispatch job for the panel: its status, rounds, the offers sent with their
 * answers, and the assignment. Rule `permissions [dispatch.job.view]`, admins only.
 */
export class ViewDispatchJob extends UseCase<ViewDispatchJobInput, DispatchJob, DispatchFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'dispatch.view-dispatch-job',
    rule: { kind: 'permissions', allOf: [JOB_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: ViewDispatchJobDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: ViewDispatchJobInput,
  ): Promise<Result<DispatchJob, DispatchFailure>> {
    if (!isAdmin(context)) return err(accessDenied());
    const deliveryId = parseId<'Delivery'>(input.deliveryId);
    if (!deliveryId.ok) return err(jobNotFound());
    const { jobs, unitOfWork } = this.deps;
    const { market } = context;
    const read = await unitOfWork.run(
      market,
      async () => ok(await jobs.findByDelivery(market, deliveryId.value)),
      { readOnly: true },
    );
    if (!read.ok) return read;
    return read.value === undefined ? err(jobNotFound()) : ok(read.value);
  }
}
