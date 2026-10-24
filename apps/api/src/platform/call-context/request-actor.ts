import { isMinted } from '@mondapac-drive/shared-kernel';
import type { ActorContext } from '@mondapac-drive/shared-kernel';

// The actor of each request (platform-foundations 5.2 rule 4). Only ActorGuard attaches it and
// only the `@Call()` decorator reads it: dependency-cruiser `request-actor-is-attached-by-the-
// actor-guard` lets no other file import this one.

/** A controller asked for the actor of a request that has none: a programmer error. */
export class MissingActorError extends Error {
  override readonly name = 'MissingActorError';
  constructor() {
    super('No actor is attached to this request; @Call() needs a market-scoped controller');
  }
}

const attached = new WeakMap<object, ActorContext>();

/** Attaches the request's actor; refuses an actor that was not minted, and a second one. */
export function attachActor(request: object, actor: ActorContext): void {
  if (!isMinted(actor)) throw new TypeError('attachActor: the actor was not minted');
  if (attached.has(request)) throw new Error('attachActor: this request already has an actor');
  attached.set(request, actor);
}

/** The actor attached to a request; throws when there is none. It never defaults. */
export function actorOf(request: object): ActorContext {
  const actor = attached.get(request);
  if (actor === undefined) throw new MissingActorError();
  return actor;
}
