import { err, ok, type CallContext, type Id, type Result } from '@mondapac-drive/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { COURIER_DECIDE, COURIER_VIEW } from '../../contracts/permissions';
import {
  courierApproved,
  courierOffboarded,
  courierReinstated,
  courierSuspendedAudit,
  courierTaxRegistrationSet,
} from '../../domain/audit-actions';
import {
  approveCourier,
  offboardCourier,
  reinstateCourier,
  setTaxRegistration,
  suspendCourier,
  type ConfirmedTerms,
  type CourierState,
} from '../../domain/courier';
import type { CourierStatus, SuspensionReason } from '../../domain/courier-status';
import { isOperator } from '../access';
import type { ChangeOfCourier } from '../courier-changes';
import { readCourier } from '../courier-reads';
import { forbidden, type FleetFailure } from '../failure';
import type { FleetDependencies } from '../fleet-dependencies';

// An operator's view of the Market's couriers and their decisions about a courier's standing.
// Every decision is audited with the operator who made it. The courier is named by its fleet id.

type Outcome<T> = Promise<Result<T, FleetFailure>>;

export interface CourierRef {
  readonly courierId: Id<'Courier'>;
}

/** The largest page of the courier list. */
export const MAX_COURIER_PAGE = 100;

export interface ListCouriersInput {
  readonly status?: CourierStatus;
  /** `next` of the previous page; absent for the first page. */
  readonly after?: Id<'Courier'>;
  readonly limit: number;
}

export interface CourierPage {
  /** Oldest first. */
  readonly items: readonly CourierState[];
  /** The `after` of the next page, or null when this page was the last. */
  readonly next: Id<'Courier'> | null;
}

/**
 * The couriers of the Market, oldest first, optionally of one standing, for the panel's list.
 * Rule `permissions [fleet.courier.view]`, admins only.
 */
export class ListCouriers extends UseCase<ListCouriersInput, CourierPage, FleetFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'fleet.list-couriers',
    rule: { kind: 'permissions', allOf: [COURIER_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: FleetDependencies,
  ) {
    super(gate);
  }

  protected async handle(context: CallContext, input: ListCouriersInput): Outcome<CourierPage> {
    if (!isOperator(context)) return err(forbidden());
    const limit = Math.min(Math.max(Math.trunc(input.limit), 1), MAX_COURIER_PAGE);
    const { market } = context;
    return this.deps.unitOfWork.run(
      market,
      async () => {
        // One row more than the page tells whether another page exists.
        const rows = await this.deps.couriers.list(market, {
          ...(input.status === undefined ? {} : { status: input.status }),
          ...(input.after === undefined ? {} : { after: input.after }),
          limit: limit + 1,
        });
        const items = rows.slice(0, limit);
        return ok({ items, next: rows.length > limit ? items[items.length - 1]!.id : null });
      },
      { readOnly: true },
    );
  }
}

/**
 * One courier of the Market with their vehicles and documents.
 * Rule `permissions [fleet.courier.view]`, admins only.
 */
export class ViewCourier extends UseCase<CourierRef, CourierState, FleetFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'fleet.view-courier',
    rule: { kind: 'permissions', allOf: [COURIER_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: FleetDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: CourierRef): Outcome<CourierState> {
    if (!isOperator(context)) return Promise.resolve(err(forbidden()));
    return readCourier(this.deps, context, { id: input.courierId }, () => true);
  }
}

/** An operator's decision about one courier, applied and audited in one unit. */
function decide(
  deps: FleetDependencies,
  context: CallContext,
  courierId: Id<'Courier'>,
  change: Omit<ChangeOfCourier, 'allowed'>,
): Outcome<CourierState> {
  if (!isOperator(context)) return Promise.resolve(err(forbidden()));
  return deps.changes.apply(context, { id: courierId }, { allowed: () => true, ...change });
}

const termsOf = (courier: CourierState) => ({
  status: courier.status,
  employmentType: courier.employmentType,
  coldChainCapable: courier.coldChainCapable,
});

export interface ApproveCourierInput extends CourierRef {
  readonly terms: ConfirmedTerms;
}

/**
 * Approves an applicant on the employment type and cold-chain capability the operator confirmed,
 * once their documents make them eligible for at least one vehicle.
 * Rule `permissions [fleet.courier.decide]`.
 */
export class ApproveCourier extends UseCase<ApproveCourierInput, CourierState, FleetFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'fleet.approve-courier',
    rule: { kind: 'permissions', allOf: [COURIER_DECIDE.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: FleetDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: ApproveCourierInput): Outcome<CourierState> {
    return decide(this.deps, context, input.courierId, {
      decide: (courier, rules, now) => approveCourier(courier, input.terms, rules, now),
      audit: (before, after) =>
        courierApproved.entry(after.id, { before: termsOf(before), after: termsOf(after) }),
    });
  }
}

export interface SuspendCourierInput extends CourierRef {
  readonly reason: SuspensionReason;
}

/** Suspends an active courier, which ends their shift. Rule `permissions [fleet.courier.decide]`. */
export class SuspendCourier extends UseCase<SuspendCourierInput, CourierState, FleetFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'fleet.suspend-courier',
    rule: { kind: 'permissions', allOf: [COURIER_DECIDE.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: FleetDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: SuspendCourierInput): Outcome<CourierState> {
    return decide(this.deps, context, input.courierId, {
      decide: (courier, _rules, now) => suspendCourier(courier, input.reason, now),
      audit: (before, after) =>
        courierSuspendedAudit.entry(after.id, {
          before: { status: before.status },
          after: { status: after.status, reason: input.reason },
        }),
    });
  }
}

/**
 * Reinstates a suspended courier whose documents still make them eligible.
 * Rule `permissions [fleet.courier.decide]`.
 */
export class ReinstateCourier extends UseCase<CourierRef, CourierState, FleetFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'fleet.reinstate-courier',
    rule: { kind: 'permissions', allOf: [COURIER_DECIDE.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: FleetDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: CourierRef): Outcome<CourierState> {
    return decide(this.deps, context, input.courierId, {
      decide: (courier, rules, now) => reinstateCourier(courier, rules, now),
      audit: (before, after) =>
        courierReinstated.entry(after.id, {
          before: { status: before.status },
          after: { status: after.status },
        }),
    });
  }
}

/** Ends a courier's work with the operator for good. Rule `permissions [fleet.courier.decide]`. */
export class OffboardCourier extends UseCase<CourierRef, CourierState, FleetFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'fleet.offboard-courier',
    rule: { kind: 'permissions', allOf: [COURIER_DECIDE.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: FleetDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: CourierRef): Outcome<CourierState> {
    return decide(this.deps, context, input.courierId, {
      decide: (courier, _rules, now) => offboardCourier(courier, now),
      audit: (before, after) =>
        courierOffboarded.entry(after.id, {
          before: { status: before.status },
          after: { status: after.status },
        }),
    });
  }
}

export interface TaxRegistrationInput extends CourierRef {
  readonly taxRegistered: boolean;
}

/**
 * Records whether the courier is registered for the Market's sales tax, from their business
 * registration. Payouts adds the tax to a registered contractor's earnings, so every change is
 * audited with its old and new value. Rule `permissions [fleet.courier.decide]`.
 */
export class SetCourierTaxRegistration extends UseCase<
  TaxRegistrationInput,
  CourierState,
  FleetFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'fleet.set-courier-tax-registration',
    rule: { kind: 'permissions', allOf: [COURIER_DECIDE.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: FleetDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: TaxRegistrationInput): Outcome<CourierState> {
    return decide(this.deps, context, input.courierId, {
      decide: (courier) => setTaxRegistration(courier, input.taxRegistered),
      audit: (before, after) =>
        courierTaxRegistrationSet.entry(after.id, {
          before: { taxRegistered: before.taxRegistered },
          after: { taxRegistered: after.taxRegistered },
        }),
    });
  }
}
