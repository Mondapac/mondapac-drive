import { err, ok, type CallContext, type Id, type Result } from '@mondapac-drive/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { LEDGER_VIEW } from '../../contracts/permissions';
import type { PayoutLine, PayoutLineStatus } from '../../domain/payout-run';
import { isAdmin } from '../callers';
import type { PayoutsDependencies } from '../dependencies';
import { ACCESS_DENIED, type PayoutsFailure } from '../failure';

export interface PayoutLineQuery {
  readonly statuses: readonly PayoutLineStatus[];
  readonly courierId?: string;
  readonly limit?: number;
  readonly after?: Id<'PayoutLine'>;
}

export interface PayoutLinePage {
  readonly lines: readonly PayoutLine[];
  /** The cursor of the next page, when there is one. */
  readonly next?: Id<'PayoutLine'>;
}

export const DEFAULT_LINE_PAGE = 50;
export const MAX_LINE_PAGE = 200;

/**
 * Payout lines in the asked states, oldest first, a page at a time: the operator's view of held
 * lines (and why), unresolved lines to settle, and failures. Rule
 * `permissions [payouts.ledger.view]`, admins only.
 */
export class ListPayoutLines extends UseCase<PayoutLineQuery, PayoutLinePage, PayoutsFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'payouts.list-payout-lines',
    rule: { kind: 'permissions', allOf: [LEDGER_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: PayoutsDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: PayoutLineQuery,
  ): Promise<Result<PayoutLinePage, PayoutsFailure>> {
    if (!isAdmin(context)) return err(ACCESS_DENIED);
    const { market } = context;
    const limit = Math.min(Math.max(Math.trunc(input.limit ?? DEFAULT_LINE_PAGE), 1), MAX_LINE_PAGE);
    const found = await this.deps.unitOfWork.run(
      market,
      async () =>
        ok(
          await this.deps.runs.listLines(market, {
            statuses: input.statuses,
            limit: limit + 1,
            ...(input.courierId === undefined ? {} : { courierId: input.courierId }),
            ...(input.after === undefined ? {} : { after: input.after }),
          }),
        ),
      { readOnly: true },
    );
    if (!found.ok) return found;
    const lines = found.value.slice(0, limit);
    const last = lines.at(-1);
    return ok({
      lines,
      ...(found.value.length > limit && last !== undefined ? { next: last.id } : {}),
    });
  }
}
