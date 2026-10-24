import type { CallContext } from '@mondapac-drive/shared-kernel';
import type { CourierState } from '../domain/courier';

// Who may do what, until identity's UseCaseGate arrives (work package 2): then each use case
// declares its population and permission instead, and these checks stay as the second line.
// Until then the fleet module has no route, so only code in this process can call it.

/** An operator of the Market: a signed-in admin. */
export function isOperator(context: CallContext): boolean {
  return context.actor.kind === 'authenticated' && context.actor.population === 'admin';
}

/** The courier themself: the signed-in account the profile belongs to. */
export function isCourierThemself(context: CallContext, courier: CourierState): boolean {
  return context.actor.kind === 'authenticated' && context.actor.accountId === courier.actorId;
}

/** The account id of the signed-in caller, or undefined for a system or anonymous caller. */
export function accountOf(context: CallContext): string | undefined {
  return context.actor.kind === 'authenticated' ? context.actor.accountId : undefined;
}
