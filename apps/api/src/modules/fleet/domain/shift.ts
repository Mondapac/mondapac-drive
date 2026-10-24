import { FleetDomainError } from './errors';

/**
 * The courier's shift. A courier goes online and offline, pauses (a break) and is on a delivery
 * while carrying one. Dispatch offers work only to couriers who are online.
 */
export const SHIFT_STATES = ['offline', 'online', 'on_delivery', 'paused'] as const;
export type ShiftState = (typeof SHIFT_STATES)[number];

/** For each state, the states a courier may change it to. A courier on a delivery finishes it first. */
const SHIFT_TRANSITIONS: Readonly<Record<ShiftState, readonly ShiftState[]>> = {
  offline: ['online'],
  online: ['offline', 'paused', 'on_delivery'],
  paused: ['online', 'offline'],
  on_delivery: ['online'],
};

export function canChangeShift(from: ShiftState, to: ShiftState): boolean {
  return SHIFT_TRANSITIONS[from].includes(to);
}

export function assertShiftChange(from: ShiftState, to: ShiftState): void {
  if (!(SHIFT_STATES as readonly string[]).includes(to)) {
    throw new FleetDomainError('fleet.shift.unknown', 'Unknown shift state');
  }
  if (!canChangeShift(from, to)) {
    throw new FleetDomainError(
      'fleet.shift.transition-not-allowed',
      `A courier cannot go from ${from} to ${to}`,
    );
  }
}
