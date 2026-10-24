// The `/authenticated-actor` entry of the miniature kernel: the constructor that only
// identity's Authenticator may import (authenticated-actor-is-built-by-the-authenticator).
// tsconfig.json maps @mondapac-drive/shared-kernel/authenticated-actor here.
export interface AuthenticatedActor {
  readonly kind: 'authenticated';
  readonly accountId: string;
}
export const authenticatedActor = (accountId: string): AuthenticatedActor => ({
  kind: 'authenticated',
  accountId,
});
