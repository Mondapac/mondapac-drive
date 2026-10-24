import type { CallContext } from '@mondapac-drive/shared-kernel';
import type { NotificationsFailure } from './failure';

/** The refusal of an actor of the wrong population, after the gate admitted its keys. */
export const ACCESS_DENIED: NotificationsFailure = {
  code: 'access.denied',
  message: 'Not allowed',
};

/**
 * The merchant of a merchant actor (its API key), or null for any other actor. A merchant's id
 * comes from the key, never from a path or a body.
 */
export function merchantOf(context: CallContext): string | null {
  const { actor } = context;
  return actor.kind === 'authenticated' && actor.population === 'merchant'
    ? actor.merchantId
    : null;
}

/** Whether the actor is a signed-in admin (an operator). */
export function isAdmin(context: CallContext): boolean {
  const { actor } = context;
  return actor.kind === 'authenticated' && actor.population === 'admin';
}

/** Whether the actor is the Market's system actor (jobs and event subscribers). */
export function isSystem(context: CallContext): boolean {
  return context.actor.kind === 'system';
}
