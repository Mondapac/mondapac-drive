import { err, ok, type CallContext, type Money, type Result } from '@mondapac-drive/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { EARNINGS_VIEW, LEDGER_VIEW } from '../../contracts/permissions';
import type { Balance, LedgerEntry } from '../../domain/ledger';
import { earningPeriods } from '../../domain/payout-schedule';
import { courierOf, isAdmin } from '../callers';
import type { PayoutsDependencies } from '../dependencies';
import { ACCESS_DENIED, type PayoutsFailure } from '../failure';

export interface CourierStatement {
  readonly balance: Balance;
  /** The latest entries, newest first. */
  readonly entries: readonly LedgerEntry[];
}

export interface StatementQuery {
  readonly limit?: number;
}

/** What the courier app's earnings card shows. */
export interface EarningsSummary {
  /** Earned since local midnight and since Monday's, tax included. */
  readonly today: Money;
  readonly week: Money;
  readonly deliveriesToday: number;
}

const DEFAULT_ENTRIES = 50;
const MAX_ENTRIES = 200;

function statementOf(
  deps: PayoutsDependencies,
  context: CallContext,
  courierId: string,
  limit: number | undefined,
): Promise<Result<CourierStatement, PayoutsFailure>> {
  const { market } = context;
  const currency = deps.settings.get(market.marketId).currency;
  const bounded = Math.min(Math.max(Math.trunc(limit ?? DEFAULT_ENTRIES), 1), MAX_ENTRIES);
  return deps.unitOfWork.run(
    market,
    async () =>
      ok({
        balance: await deps.ledger.balanceOf(market, courierId, currency),
        entries: await deps.ledger.recentEntries(market, courierId, bounded),
      }),
    { readOnly: true },
  );
}

/**
 * The signed-in courier's balance and latest ledger entries. The courier is the session's
 * account. Rule `permissions [payouts.earnings.view]`, couriers only.
 */
export class GetCourierBalance extends UseCase<StatementQuery, CourierStatement, PayoutsFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'payouts.get-courier-balance',
    rule: { kind: 'permissions', allOf: [EARNINGS_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: PayoutsDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: StatementQuery,
  ): Promise<Result<CourierStatement, PayoutsFailure>> {
    const courierId = courierOf(context);
    if (courierId === null) return err(ACCESS_DENIED);
    return statementOf(this.deps, context, courierId, input.limit);
  }
}

/**
 * The signed-in courier's earnings today and this week (local days of the Market's time zone)
 * and today's deliveries, for the courier app's home. Rule `permissions [payouts.earnings.view]`,
 * couriers only.
 */
export class GetEarningsSummary extends UseCase<
  Record<string, never>,
  EarningsSummary,
  PayoutsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'payouts.get-earnings-summary',
    rule: { kind: 'permissions', allOf: [EARNINGS_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: PayoutsDependencies,
  ) {
    super(gate);
  }

  protected async handle(context: CallContext): Promise<Result<EarningsSummary, PayoutsFailure>> {
    const courierId = courierOf(context);
    if (courierId === null) return err(ACCESS_DENIED);
    const { market } = context;
    const { ledger, unitOfWork, clock } = this.deps;
    const settings = this.deps.settings.get(market.marketId);
    const { dayStart, weekStart } = earningPeriods(settings.timezone, clock.now());
    return unitOfWork.run(
      market,
      async () =>
        ok({
          today: await ledger.earnedSince(market, courierId, dayStart, settings.currency),
          week: await ledger.earnedSince(market, courierId, weekStart, settings.currency),
          deliveriesToday: await ledger.deliveriesSince(market, courierId, dayStart),
        }),
      { readOnly: true },
    );
  }
}

export interface CourierStatementQuery extends StatementQuery {
  readonly courierId: string;
}

/**
 * One courier's balance and latest entries, for operators. Rule
 * `permissions [payouts.ledger.view]`, admins only.
 */
export class ViewCourierBalance extends UseCase<
  CourierStatementQuery,
  CourierStatement,
  PayoutsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'payouts.view-courier-balance',
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
    input: CourierStatementQuery,
  ): Promise<Result<CourierStatement, PayoutsFailure>> {
    if (!isAdmin(context)) return err(ACCESS_DENIED);
    return statementOf(this.deps, context, input.courierId, input.limit);
  }
}
