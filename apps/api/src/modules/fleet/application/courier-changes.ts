import { Inject, Injectable } from '@nestjs/common';
import {
  err,
  ok,
  type AuditEntry,
  type CallContext,
  type Clock,
  type Id,
  type Result,
  type Temporal,
} from '@mondapac-drive/shared-kernel';
import { AUDIT_WRITER, type AuditWriter } from '../../../platform/audit/audit-writer';
import { CLOCK } from '../../../platform/clock/clock.module';
import { OUTBOX_WRITER, type OutboxWriter } from '../../../platform/events/outbox-writer';
import { UNIT_OF_WORK, type UnitOfWork } from '../../../platform/unit-of-work/unit-of-work';
import type { CourierChange, CourierState } from '../domain/courier';
import type { MarketFleetRules } from '../domain/fleet-rules';
import { courierNotFound, refusingBrokenRules, type FleetFailure } from './failure';
import {
  COURIER_REPOSITORY,
  FLEET_RULES,
  type CourierRepository,
  type FleetRulesProvider,
} from './ports';

/** One change of a courier, as a use case describes it to {@link CourierChanges.apply}. */
export interface ChangeOfCourier {
  /** Who may make it, seen against the stored courier. Refused callers get "not found". */
  readonly allowed: (courier: CourierState) => boolean;
  /** The domain decision; a broken rule throws `FleetDomainError`. */
  readonly decide: (
    courier: CourierState,
    rules: MarketFleetRules,
    now: Temporal.Instant,
  ) => CourierChange;
  /** The audit row of an operator decision, written in the same unit. */
  readonly audit?: (before: CourierState, after: CourierState) => AuditEntry | undefined;
}

/**
 * Loads a courier, applies one change and saves it with its events and audit row, all in one
 * read-write unit: the courier, the outbox and the audit log commit together or not at all.
 */
@Injectable()
export class CourierChanges {
  constructor(
    @Inject(COURIER_REPOSITORY) private readonly couriers: CourierRepository,
    @Inject(FLEET_RULES) private readonly rules: FleetRulesProvider,
    @Inject(UNIT_OF_WORK) private readonly unitOfWork: UnitOfWork,
    @Inject(OUTBOX_WRITER) private readonly outbox: OutboxWriter,
    @Inject(AUDIT_WRITER) private readonly auditLog: AuditWriter,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  apply(
    context: CallContext,
    courierId: Id<'Courier'>,
    change: ChangeOfCourier,
  ): Promise<Result<CourierState, FleetFailure>> {
    const rules = this.rules.get(context.market.marketId);
    return this.unitOfWork.run(context.market, () =>
      refusingBrokenRules(async () => {
        const courier = await this.couriers.findById(context.market, courierId);
        if (courier === undefined || !change.allowed(courier)) return err(courierNotFound());
        const decided = change.decide(courier, rules, this.clock.now());
        if (decided.courier === courier) return ok(courier);
        await this.couriers.update(context.market, decided.courier);
        if (decided.events.length > 0) await this.outbox.append(context, decided.events);
        const entry = change.audit?.(courier, decided.courier);
        if (entry !== undefined) await this.auditLog.record(context, entry);
        return ok(decided.courier);
      }),
    );
  }
}
