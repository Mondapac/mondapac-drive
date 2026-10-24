import type { CallContext } from '@mondapac-drive/shared-kernel';
import { failure } from './failure';

/** The refusal of an actor of the wrong population, after the gate admitted its keys. */
export const ACCESS_DENIED = failure('access.denied', 'Not allowed');

/**
 * The courier of a courier actor, or null for any other actor. A courier's id is its identity
 * account id, taken from the session, never from a path or a body.
 */
export function courierOf(context: CallContext): string | null {
  const { actor } = context;
  return actor.kind === 'authenticated' && actor.population === 'courier' ? actor.accountId : null;
}

/** Whether the actor is a signed-in admin (an operator or a dispatcher). */
export function isAdmin(context: CallContext): boolean {
  const { actor } = context;
  return actor.kind === 'authenticated' && actor.population === 'admin';
}

/** Whether the actor is the Market's system actor (jobs and event subscribers). */
export function isSystem(context: CallContext): boolean {
  return context.actor.kind === 'system';
}
