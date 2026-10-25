import type { CallContext, Id, Population, Result } from '@mondapac-drive/shared-kernel';
import type { AccessDenied } from '../../../platform/authz';

/**
 * Who the calling actor is (identity design 8.1 `describeActor`): ids and codes only, never a
 * name or an email. `merchantId` and `merchantState` are set for a merchant actor only; the
 * effective permission keys are sorted.
 */
export interface ActorDescription {
  readonly accountId: Id<'Account'>;
  readonly population: Population;
  readonly merchantId: Id<'Merchant'> | null;
  readonly roleId: string | null;
  readonly permissionKeys: readonly string[];
  readonly merchantState: 'active' | 'suspended' | null;
  readonly secondFactorActive: boolean;
}

/**
 * The public facade of `identity` (identity design 8.1). Every method takes the caller's
 * `CallContext` first, unchanged, and is a thin call of one use case, so the gate runs (PF 6.4
 * row 2). Other modules inject {@link IDENTITY_FACADE}; they never read identity's tables.
 */
export interface IdentityFacade {
  /** Rule `own-resources`. */
  describeActor(context: CallContext): Promise<Result<ActorDescription, AccessDenied>>;

  /**
   * The address to mail a notice to, for the `system` caller only: an admin's or a courier's own
   * sign-in address. `null` when there is none to use: unknown, of another Market, a merchant's
   * integration account, disabled or not verified, all alike. Personal data: the caller uses it
   * for one send and never logs, stores or puts it in an event.
   */
  contactEmailOf(
    context: CallContext,
    accountId: Id<'Account'>,
  ): Promise<Result<string | null, AccessDenied>>;

  /**
   * Whether `accountId` is an active courier account of the context's Market. Rule `permissions
   * [identity.courier-account.view]`: a dispatcher checks a courier before assigning a job.
   */
  isActiveCourier(
    context: CallContext,
    accountId: Id<'Account'>,
  ): Promise<Result<boolean, AccessDenied>>;

  /**
   * Which of `sessionIds` of `accountId` are live now (not revoked, expired or idle), for the
   * `system` caller only: notifications pushes only to the device of a live courier session.
   * `identity.unavailable` when the read failed; never an empty set for a failure.
   */
  liveSessionsOf(
    context: CallContext,
    accountId: Id<'Account'>,
    sessionIds: readonly string[],
  ): Promise<Result<ReadonlySet<string>, AccessDenied | { readonly code: 'identity.unavailable' }>>;
}

/** Nest token of the {@link IdentityFacade}, provided and exported by `IdentityModule`. */
export const IDENTITY_FACADE = Symbol('IDENTITY_FACADE');
