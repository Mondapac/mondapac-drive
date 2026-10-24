import { err, ok, type CallContext, type Clock, type Result } from '@mondapac-drive/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { isSystem } from '../callers';
import { accessDenied, type DispatchFailure } from '../failure';
import type { JobAdvancer } from '../job-advancer';
import type { DispatchJobRepository } from '../ports';

/** The most jobs one sweep advances for a Market; the rest wait for the next tick. */
export const SWEEP_BATCH = 100;

export interface AdvanceDispatchJobsDependencies {
  readonly jobs: DispatchJobRepository;
  readonly unitOfWork: UnitOfWork;
  readonly clock: Clock;
  readonly advancer: JobAdvancer;
}

/**
 * The sweep (run by the `dispatch.advance-jobs` job): every open job whose next action is due
 * is advanced in its own unit. Offer timeouts run here, never on a timer in the domain. Safe to
 * run twice and concurrently: a job changed meanwhile is skipped as stale. Rule `system`.
 */
export class AdvanceDispatchJobs extends UseCase<
  Record<string, never>,
  { readonly advanced: number },
  DispatchFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'dispatch.advance-dispatch-jobs',
    rule: { kind: 'system' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: AdvanceDispatchJobsDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
  ): Promise<Result<{ readonly advanced: number }, DispatchFailure>> {
    if (!isSystem(context)) return err(accessDenied());
    const { jobs, unitOfWork, clock, advancer } = this.deps;
    const { market } = context;
    const due = await unitOfWork.run(
      market,
      async () => ok(await jobs.findDue(market, clock.now(), SWEEP_BATCH)),
      { readOnly: true },
    );
    let advanced = 0;
    for (const id of due.ok ? due.value : []) {
      if ((await advancer.advance(context, id)) === 'advanced') advanced += 1;
    }
    return ok({ advanced });
  }
}
