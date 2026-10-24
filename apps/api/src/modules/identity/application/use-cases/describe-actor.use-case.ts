import { err, ok } from '@mondapac-drive/shared-kernel';
import type { CallContext, Id, Population, Result } from '@mondapac-drive/shared-kernel';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { MerchantStateCode } from '../../domain/merchant';
import type { EffectiveKeyResolver } from '../access/effective-keys';
import type { AccountRepository } from '../ports/account.repository';
import type { MerchantRepository } from '../ports/merchant.repository';
import type { RoleGrantReader } from '../ports/role-grant-reader';
import type { SecondFactorRepository } from '../ports/second-factor.repository';
import type { SessionRepository } from '../ports/session.repository';
import type { SignInRecordRepository } from '../ports/sign-in-record.repository';

/**
 * The actor's own summary (identity design 8.1 `describeActor`, 8.6 rows 2 and 9). The ids and
 * codes are what the facade returns; `email` and `displayName` are personal data for the HTTP
 * summary only and never go into an event, a log or an audit row. The role and the merchant's
 * state are read with it; the effective permission keys by the gate's own resolver.
 */
export interface ActorSummary {
  readonly accountId: Id<'Account'>;
  readonly population: Population;
  readonly merchantId: Id<'Merchant'> | null;
  /** The account's one role; null while it has none. */
  readonly roleId: string | null;
  /** The effective keys (`effectiveKeysOf`), sorted. A hint: the gate decides. */
  readonly permissionKeys: readonly string[];
  /** The merchant's state for a merchant actor; null otherwise. */
  readonly merchantState: MerchantStateCode | null;
  readonly secondFactorActive: boolean;
  /**
   * The previous successful sign-in of the account, before the one that opened this session
   * (ISO 8601, UTC); null when there is none or the records no longer hold it (they are purged
   * after the Market's retention). The time only: never an address (profile package).
   */
  readonly lastSignInAt: string | null;
  readonly email: string;
  readonly displayName: string;
  /** The holder's own IANA time zone, or null when none was chosen. */
  readonly timezone: string | null;
  /** The holder's panel language, or null when none was chosen. */
  readonly locale: string | null;
  /** The panel counts idle time from its own last request (8.6 row 9). */
  readonly session: {
    readonly idleTimeoutSeconds: number;
    /** ISO 8601, UTC. */
    readonly absoluteExpiresAt: string;
  };
}

export type DescribeActorFailure = { readonly code: 'access.denied' };

export interface DescribeActorDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly accounts: AccountRepository;
  readonly sessions: SessionRepository;
  readonly merchants: Pick<MerchantRepository, 'findById'>;
  readonly grants: RoleGrantReader;
  /** The resolver of `EFFECTIVE_KEY_RESOLVER`, the gate's (N-1). */
  readonly effectiveKeys: EffectiveKeyResolver;
  /** Slice 7b: whether the account's factor is active (8.1, 8.6). */
  readonly factors: SecondFactorRepository;
  /** The profile page's last sign-in. */
  readonly records: SignInRecordRepository;
}

/**
 * Describes the calling actor (identity design 8.1, 8.6). Rule `own-resources`. Reads the account, the session, the account's role grant
 * (the gate's grant read: one probe of the assignment gives both the role id and the keys, from
 * one snapshot; Mojtaba N1) and, for a merchant actor, its merchant's state, in one
 * read-only unit; the actor's ids come from the context, never from input.
 */
export class DescribeActor extends UseCase<
  Record<string, never>,
  ActorSummary,
  DescribeActorFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'identity.describe-actor',
    rule: { kind: 'own-resources' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: DescribeActorDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
  ): Promise<Result<ActorSummary, DescribeActorFailure>> {
    const { market, actor } = context;
    if (actor.kind !== 'authenticated') return err({ code: 'access.denied' });
    const read = await this.deps.unitOfWork.run(
      market,
      async () =>
        ok({
          account: await this.deps.accounts.findById(market, actor.accountId),
          session: await this.deps.sessions.findById(market, actor.sessionId),
          grant:
            (await this.deps.grants.grantsOf(market, [actor.accountId])).get(actor.accountId) ??
            null,
          merchant:
            actor.merchantId === null
              ? null
              : await this.deps.merchants.findById(market, actor.merchantId),
          factorActive: (await this.deps.factors.activeAmong(market, [actor.accountId])).has(
            actor.accountId,
          ),
          lastSignIn: await this.deps.records.latestSuccessBefore(
            market,
            actor.accountId,
            actor.sessionId,
          ),
        }),
      { readOnly: true },
    );
    if (!read.ok) return err({ code: 'access.denied' });
    const { account, session, merchant, grant, factorActive, lastSignIn } = read.value;
    if (account === null || session === null || session.accountId !== actor.accountId) {
      return err({ code: 'access.denied' });
    }
    return ok({
      accountId: actor.accountId,
      population: actor.population,
      merchantId: actor.merchantId,
      roleId: grant?.roleId ?? null,
      permissionKeys: [
        ...this.deps.effectiveKeys({
          population: actor.population,
          accountId: actor.accountId,
          merchantId: actor.merchantId,
          grant,
        }),
      ].sort(),
      merchantState: merchant?.state.state ?? null,
      secondFactorActive: factorActive,
      lastSignInAt: lastSignIn === null ? null : lastSignIn.toString(),
      email: account.state.email.typed,
      displayName: account.state.displayName,
      timezone: account.state.timezone ?? null,
      locale: account.state.locale ?? null,
      session: {
        idleTimeoutSeconds: session.idleTimeoutSeconds,
        absoluteExpiresAt: session.absoluteExpiresAt.toString(),
      },
    });
  }
}
