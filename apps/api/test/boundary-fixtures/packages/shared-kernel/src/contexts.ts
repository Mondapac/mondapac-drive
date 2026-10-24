// The `/contexts` entry of the miniature kernel: the actor and call-context constructors and
// types, which only platform/ may import (contexts-are-built-by-platform). tsconfig.json maps
// @mondapac-drive/shared-kernel/contexts here, so the fixtures resolve without the real entry.
export type ActorContext = AnonymousActor | SystemActor | AuthenticatedActor;
export interface AnonymousActor {
  readonly kind: 'anonymous';
}
export interface SystemActor {
  readonly kind: 'system';
  readonly marketId?: string;
}
export interface AuthenticatedActor {
  readonly kind: 'authenticated';
}
export interface CallContext {
  readonly actor: ActorContext;
}
export const anonymousActor = (): AnonymousActor => ({ kind: 'anonymous' });
export const systemActor = (market?: { readonly marketId: string }): SystemActor =>
  market ? { kind: 'system', marketId: market.marketId } : { kind: 'system' };
export const createCallContext = (actor: ActorContext): CallContext => ({ actor });
