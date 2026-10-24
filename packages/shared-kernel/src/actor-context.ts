import { parseId } from './id';
import type { Id } from './id';
import { isMinted, mint } from './minted';
import type { Minted } from './minted';
import type { MarketContext, MarketId } from './market-context';

/**
 * Who is acting, as identifiers (ADR-0018 decision 4; platform-foundations design 3.4;
 * identity design 4). A closed union on `kind`: anonymous is an explicit value, never
 * `undefined` or `null`, and no kind is a default. Every kind carries the Market it was
 * established in. Roles, permissions, the merchant's state, second-factor status, an
 * email, a name, a token, an address or a user agent never travel in it: `identity` reads
 * them on each check.
 *
 * All three kinds are minted. The anonymous and system actors are built by the platform's
 * entry adapters through the `@mondapac-drive/shared-kernel/contexts` entry; the authenticated
 * actor only by `identity`'s `Authenticator`, through the `/authenticated-actor` entry.
 */
export type ActorContext = AnonymousActor | SystemActor | AuthenticatedActor;

/** A request with no session, in its Market. */
export interface AnonymousActor extends Minted<'AnonymousActor'> {
  readonly kind: 'anonymous';
  readonly marketId: MarketId;
}

/** A job, a consumed event or a platform routine of one Market. It has no account id. */
export interface SystemActor extends Minted<'SystemActor'> {
  readonly kind: 'system';
  readonly marketId: MarketId;
}

/**
 * The populations of Drive (marketplace identity design 4, adapted): `admin` is Mondapac's
 * operators and dispatchers, `merchant` a business that books deliveries (today through its API
 * keys), `courier` a person who carries them.
 */
export const POPULATIONS = ['admin', 'merchant', 'courier'] as const;
export type Population = (typeof POPULATIONS)[number];

/**
 * A person signed in through a valid session (identity design 4, rules 1 to 6). `population`
 * fixes the scope of the permissions it may hold and grants nothing by itself.
 */
export interface AuthenticatedActor extends Minted<'AuthenticatedActor'> {
  readonly kind: 'authenticated';
  /** The Market of the account and of the session. */
  readonly marketId: MarketId;
  readonly population: Population;
  readonly accountId: Id<'Account'>;
  /** An id, never the token. A merchant API key is a session too. */
  readonly sessionId: Id<'Session'>;
  /** Set if and only if `population` is `merchant`: the merchant of the active membership. */
  readonly merchantId: Id<'Merchant'> | null;
}

/** The fields of an authenticated actor other than its kind and Market. */
export type AuthenticatedActorFields = Pick<
  AuthenticatedActor,
  'population' | 'accountId' | 'sessionId' | 'merchantId'
>;

function marketOf(market: MarketContext, constructor: string): MarketId {
  if (!isMinted(market)) {
    throw new TypeError(`${constructor}: the MarketContext was not minted`);
  }
  return market.marketId;
}

/** The anonymous actor of a Market. Called by the platform's entry adapters only. */
export function anonymousActor(market: MarketContext): AnonymousActor {
  return mint<AnonymousActor>({ kind: 'anonymous', marketId: marketOf(market, 'anonymousActor') });
}

/** The system actor of a Market. Called by the platform's entry adapters only. */
export function systemActor(market: MarketContext): SystemActor {
  return mint<SystemActor>({ kind: 'system', marketId: marketOf(market, 'systemActor') });
}

/**
 * Exported as `authenticatedActor` on the `@mondapac-drive/shared-kernel/authenticated-actor` entry
 * (identity slice 2), for the one file of `identity` that builds actors from a session, its
 * `Authenticator` (foundations 3.7), and called by the `/testing` builders. Every field is
 * checked again at run time: the brands are compile-time only, and the constructor throws when
 * `merchantId` and `population` disagree. Only the declared fields are copied.
 */
export function mintAuthenticatedActor(
  market: MarketContext,
  fields: AuthenticatedActorFields,
): AuthenticatedActor {
  const marketId = marketOf(market, 'authenticatedActor');
  const { population, accountId, sessionId, merchantId } = fields;
  if (!(POPULATIONS as readonly unknown[]).includes(population)) {
    throw new TypeError('authenticatedActor: unknown population');
  }
  if (!parseId(accountId).ok || !parseId(sessionId).ok) {
    throw new TypeError('authenticatedActor: the account id and session id must be parsed ids');
  }
  const isMerchant = population === 'merchant';
  if (isMerchant ? merchantId === null || !parseId(merchantId).ok : merchantId !== null) {
    throw new TypeError(
      'authenticatedActor: a merchant id is set if and only if the population is merchant',
    );
  }
  return mint<AuthenticatedActor>({
    kind: 'authenticated',
    marketId,
    population,
    accountId,
    sessionId,
    merchantId,
  });
}
