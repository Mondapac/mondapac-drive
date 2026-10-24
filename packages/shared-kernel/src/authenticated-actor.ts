// The `@mondapac-drive/shared-kernel/authenticated-actor` entry (identity slice 2; platform-foundations
// design 3.7; identity design 4 rule 1): the constructor of an authenticated actor. Only the one
// file of `identity` that builds actors from a valid session, its `Authenticator`, may import
// this entry (dependency-cruiser rule `authenticated-actor-is-built-by-the-authenticator`); the
// platform's entry adapters never build one, and tests use the `/testing` builders.
//
// Named exports only. The constructor checks every field again at run time and throws when
// `sellerId` and `population` disagree.
export { mintAuthenticatedActor as authenticatedActor } from './actor-context';
export type { AuthenticatedActorFields } from './actor-context';
