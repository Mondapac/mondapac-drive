import { Injectable } from '@nestjs/common';
import { err, type CallContext, type Id, type Result } from '@mondapac-drive/shared-kernel';
import {
  courierApproved,
  courierOffboarded,
  courierReinstated,
  courierSuspendedAudit,
} from '../domain/audit-actions';
import {
  approveCourier,
  offboardCourier,
  reinstateCourier,
  suspendCourier,
  type CourierState,
} from '../domain/courier';
import type { SuspensionReason } from '../domain/courier-status';
import { isOperator } from './access';
import { CourierChanges } from './courier-changes';
import { forbidden, type FleetFailure } from './failure';

// An operator's decisions about a courier's standing. Each is audited with the operator who
// made it. Their routes arrive with identity's admin population (work package 2).

type Outcome = Promise<Result<CourierState, FleetFailure>>;

/** Approves an applicant whose documents make them eligible for at least one vehicle. */
@Injectable()
export class ApproveCourier {
  constructor(private readonly changes: CourierChanges) {}

  execute(context: CallContext, courierId: Id<'Courier'>): Outcome {
    if (!isOperator(context)) return Promise.resolve(err(forbidden()));
    return this.changes.apply(context, courierId, {
      allowed: () => true,
      decide: approveCourier,
      audit: (before, after) =>
        courierApproved.entry(after.id, {
          before: { status: before.status },
          after: { status: after.status },
        }),
    });
  }
}

/** Suspends an active courier, which ends their shift. */
@Injectable()
export class SuspendCourier {
  constructor(private readonly changes: CourierChanges) {}

  execute(context: CallContext, courierId: Id<'Courier'>, reason: SuspensionReason): Outcome {
    if (!isOperator(context)) return Promise.resolve(err(forbidden()));
    return this.changes.apply(context, courierId, {
      allowed: () => true,
      decide: (courier, _rules, now) => suspendCourier(courier, reason, now),
      audit: (before, after) =>
        courierSuspendedAudit.entry(after.id, {
          before: { status: before.status },
          after: { status: after.status, reason },
        }),
    });
  }
}

@Injectable()
export class ReinstateCourier {
  constructor(private readonly changes: CourierChanges) {}

  execute(context: CallContext, courierId: Id<'Courier'>): Outcome {
    if (!isOperator(context)) return Promise.resolve(err(forbidden()));
    return this.changes.apply(context, courierId, {
      allowed: () => true,
      decide: reinstateCourier,
      audit: (before, after) =>
        courierReinstated.entry(after.id, {
          before: { status: before.status },
          after: { status: after.status },
        }),
    });
  }
}

/** Ends a courier's work with the operator for good. */
@Injectable()
export class OffboardCourier {
  constructor(private readonly changes: CourierChanges) {}

  execute(context: CallContext, courierId: Id<'Courier'>): Outcome {
    if (!isOperator(context)) return Promise.resolve(err(forbidden()));
    return this.changes.apply(context, courierId, {
      allowed: () => true,
      decide: (courier, _rules, now) => offboardCourier(courier, now),
      audit: (before, after) =>
        courierOffboarded.entry(after.id, {
          before: { status: before.status },
          after: { status: after.status },
        }),
    });
  }
}
