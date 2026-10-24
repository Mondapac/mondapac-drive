import type { CallContext, Id } from '@mondapac-drive/shared-kernel';

/**
 * The courier of a courier actor, or null for any other actor. A courier's id is its identity
 * account id, taken from the session, never from a path or a body.
 */
export function courierOf(context: CallContext): Id<'Courier'> | null {
  const { actor } = context;
  return actor.kind === 'authenticated' && actor.population === 'courier'
    ? (actor.accountId as string as Id<'Courier'>)
    : null;
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
