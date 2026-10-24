import type { CallContext } from '@mondapac-drive/shared-kernel';
import type { CourierState } from '../domain/courier';

// The second line behind the UseCaseGate: the gate admits the permission keys, and each use case
// checks the caller's population and, for a courier, that the profile is their own.

/** The account of a signed-in courier, or undefined for any other caller. */
export function courierAccountOf(context: CallContext): string | undefined {
  const { actor } = context;
  return actor.kind === 'authenticated' && actor.population === 'courier'
    ? actor.accountId
    : undefined;
}

/** An operator or dispatcher of the Market: a signed-in admin. */
export function isOperator(context: CallContext): boolean {
  return context.actor.kind === 'authenticated' && context.actor.population === 'admin';
}

/** The courier themself: the signed-in courier account the profile belongs to. */
export function isCourierThemself(context: CallContext, courier: CourierState): boolean {
  const account = courierAccountOf(context);
  return account !== undefined && account === courier.actorId;
}

/** The Market's system actor (jobs and other modules' subscribers). */
export function isSystem(context: CallContext): boolean {
  return context.actor.kind === 'system';
}
