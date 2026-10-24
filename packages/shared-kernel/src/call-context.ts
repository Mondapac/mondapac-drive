import type { ActorContext } from './actor-context';
import { parseCorrelationId } from './correlation-id';
import type { CorrelationId } from './correlation-id';
import { isMinted, mint } from './minted';
import type { Minted } from './minted';
import type { MarketContext } from './market-context';

/**
 * What every use case and facade method takes first (platform-foundations design 5.2; ADR-0018
 * decision 4, ADR-0008 decision 5): the Market, the actor and the correlation id of one piece
 * of work, as one minted value. It is built once by an entry adapter (HTTP request, scheduled
 * job, consumed event) and passed on unchanged: no code replaces the actor of a context it
 * received, and a context cannot be rebuilt from JSON or copied with a spread.
 */
export interface CallContext extends Minted<'CallContext'> {
  readonly market: MarketContext;
  readonly actor: ActorContext;
  readonly correlationId: CorrelationId;
}

/** Why {@link createCallContext} refused its parts. */
export type ContextMismatchReason = 'not-minted' | 'market-mismatch';

/**
 * The parts of a context do not belong together: one was not minted, or the actor was
 * established in another Market than the context's. The entry adapter turns it into a denial.
 */
export class ContextMismatchError extends Error {
  override readonly name = 'ContextMismatchError';
  constructor(readonly reason: ContextMismatchReason) {
    super(`The parts of the call context do not belong together: ${reason}`);
  }
}

/**
 * Mints the context of one piece of work. Called by the platform's entry adapters only, through
 * the `@mondapac-drive/shared-kernel/contexts` entry. "An actor is valid only in its own Market" is
 * enforced here, once (foundations 5.2 rule 3).
 *
 * Throws {@link ContextMismatchError} when the market or the actor was not minted, or when the
 * actor's Market is not the context's; a correlation id outside its pattern is a programmer
 * error and throws a TypeError.
 */
export function createCallContext<A extends ActorContext>(
  market: MarketContext,
  actor: A,
  correlationId: CorrelationId,
): CallContext & { readonly actor: A } {
  if (!isMinted(market) || !isMinted(actor)) throw new ContextMismatchError('not-minted');
  if (actor.marketId !== market.marketId) throw new ContextMismatchError('market-mismatch');
  if (!parseCorrelationId(correlationId).ok) {
    throw new TypeError('createCallContext: the correlation id must be a parsed value');
  }
  return mint<CallContext>({ market, actor, correlationId }) as CallContext & {
    readonly actor: A;
  };
}
