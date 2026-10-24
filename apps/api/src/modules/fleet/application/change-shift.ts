import { Injectable } from '@nestjs/common';
import type { CallContext, Id, Result } from '@mondapac-drive/shared-kernel';
import { changeShift, type CourierState } from '../domain/courier';
import type { ShiftState } from '../domain/shift';
import { isCourierThemself } from './access';
import { CourierChanges } from './courier-changes';
import type { FleetFailure } from './failure';

/** The courier goes online or offline, pauses, or starts and ends a delivery. */
@Injectable()
export class ChangeShift {
  constructor(private readonly changes: CourierChanges) {}

  execute(
    context: CallContext,
    courierId: Id<'Courier'>,
    to: ShiftState,
  ): Promise<Result<CourierState, FleetFailure>> {
    return this.changes.apply(context, courierId, {
      allowed: (courier) => isCourierThemself(context, courier),
      decide: (courier, rules, now) => changeShift(courier, to, rules, now),
    });
  }
}
