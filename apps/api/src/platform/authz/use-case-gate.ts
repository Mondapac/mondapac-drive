import { Logger } from '@nestjs/common';
import { err, isMinted, ok } from '@mondapac-drive/shared-kernel';
import type { CallContext, Result } from '@mondapac-drive/shared-kernel';
import { anonymousActor, createCallContext } from '@mondapac-drive/shared-kernel/contexts';
import type { MarketRegistry } from '../market-config/market-registry';
import { DENIED, UNAUTHENTICATED, UNAVAILABLE, type AccessDenied } from './access-denied';
import { accessDeclarationOf, type AccessDeclaration } from './access-rule';
import type { AccessDecision, AuthorisationCheck } from './authorisation-check';

/** Why the gate refused, for the log only. */
type DenialReason =
  | 'declaration-missing'
  | 'declaration-invalid'
  | 'context-not-minted'
  | 'market-not-hosted'
  | 'market-mismatch'
  | 'system-only'
  | 'system-actor-not-allowed'
  | 'authentication-required'
  | 'check-unbound'
  | 'check-denied'
  | 'check-malformed'
  | 'gate-error';

class Denial {
  constructor(
    readonly reason: DenialReason,
    readonly answer: AccessDenied,
  ) {}
}

/** The key of the constructor: private to this file (M1). */
const CONSTRUCTION: unique symbol = Symbol('UseCaseGate.construction');
/** Every gate this file built. */
const gates = new WeakSet<object>();

/** The check's answer, or a denial when it is not one of the shapes the port allows. */
function decisionOf(decision: AccessDecision): Denial | null {
  if (typeof decision !== 'object' || decision === null) {
    return new Denial('check-malformed', UNAVAILABLE);
  }
  if (decision.allowed === true) return null;
  if (decision.allowed !== false || typeof decision.denial !== 'object') {
    return new Denial('check-malformed', UNAVAILABLE);
  }
  const denial = decision.denial;
  switch (denial.code) {
    case 'access.denied':
      return new Denial('check-denied', DENIED);
    case 'access.unavailable':
      return new Denial('check-denied', UNAVAILABLE);
    default:
      return new Denial('check-malformed', UNAVAILABLE);
  }
}

/**
 * The access-rule mechanism of `platform/authz` (identity design 5.2; platform-foundations
 * design 6.4). `UseCase.execute` calls {@link admit} before `handle`, for every entry point:
 * HTTP, jobs, event handlers, facade calls and later AI tools. In order, it:
 *
 * 1. reads the declaration only as an own property of the use-case class (HF4);
 * 2. refuses a context that was not minted (C2), and a Market this Region Stack does not host
 *    (W2 of the slice 0 review);
 * 3. compares the actor's Market with the context's;
 * 4. decides `system` and `anonymous` itself; under `anonymous` the use case always receives
 *    the Market's anonymous actor, so nothing branches on a signed-in visitor (HF9);
 * 5. for an authenticated actor under `permissions` or `own-resources`, asks the
 *    `AuthorisationCheck` port (identity, from slice 2).
 *
 * An exception inside the gate is a denial (`access.unavailable`). Every denial is logged with
 * the use-case name, the rule, the actor and its id, and the correlation id. The gate opens no
 * unit of work: the use-case body does that, after admission (platform persistence 3.4).
 *
 * Final: a subclass could replace the decision, so the constructor refuses one. Minted: the
 * constructor needs a key private to this file, so a gate exists only through
 * {@link createUseCaseGate}, which only `platform/authz/` may import (dependency-cruiser
 * `use-case-gate-is-built-by-authz`); `UseCase` accepts only a gate {@link isUseCaseGate}
 * recognises (security review of slice 1c, M1). A module never sees this class as a value: it
 * injects {@link USE_CASE_GATE} and names the type through the `platform/authz` barrel.
 */
export class UseCaseGate {
  readonly #logger = new Logger('UseCaseGate');
  readonly #markets: MarketRegistry;
  /**
   * Identity's check, bound by `AuthzModule` (slice 2). `null` only where a test builds a gate
   * without one: every authenticated actor is then refused with `access.unavailable`.
   */
  readonly #authorisation: AuthorisationCheck | null;

  constructor(
    key: typeof CONSTRUCTION,
    markets: MarketRegistry,
    authorisation: AuthorisationCheck | null,
  ) {
    if (new.target !== UseCaseGate) {
      throw new TypeError('UseCaseGate is final; it cannot be subclassed');
    }
    if (key !== CONSTRUCTION) {
      throw new TypeError('A UseCaseGate is built by platform/authz only');
    }
    this.#markets = markets;
    this.#authorisation = authorisation;
    gates.add(this);
  }

  /**
   * Admits a call of `useCase` under `context`. Answers the context the use case must run
   * with (for `anonymous`, the Market's anonymous actor), or the refusal.
   */
  async admit(useCase: unknown, context: CallContext): Promise<Result<CallContext, AccessDenied>> {
    let declaration: AccessDeclaration | null = null;
    try {
      const declared = accessDeclarationOf(useCase);
      if (!declared.ok) {
        return this.deny(
          null,
          context,
          new Denial(
            declared.error.code === 'declaration-missing'
              ? 'declaration-missing'
              : 'declaration-invalid',
            DENIED,
          ),
        );
      }
      declaration = declared.value;
      const decided = await this.decide(declaration, context);
      return decided instanceof Denial ? this.deny(declaration, context, decided) : ok(decided);
    } catch {
      return this.deny(declaration, context, new Denial('gate-error', UNAVAILABLE));
    }
  }

  private async decide(
    declaration: AccessDeclaration,
    context: CallContext,
  ): Promise<CallContext | Denial> {
    if (!isMinted(context) || !isMinted(context.market) || !isMinted(context.actor)) {
      return new Denial('context-not-minted', DENIED);
    }
    const { market, actor } = context;
    if (!this.#markets.isHosted(market.marketId)) return new Denial('market-not-hosted', DENIED);
    if (actor.marketId !== market.marketId) return new Denial('market-mismatch', DENIED);

    const { rule } = declaration;
    if (rule.kind === 'system') {
      return actor.kind === 'system' ? context : new Denial('system-only', DENIED);
    }
    if (actor.kind === 'system') return new Denial('system-actor-not-allowed', DENIED);
    if (rule.kind === 'anonymous') {
      return actor.kind === 'anonymous'
        ? context
        : createCallContext(market, anonymousActor(market), context.correlationId);
    }
    if (actor.kind === 'anonymous') return new Denial('authentication-required', UNAUTHENTICATED);
    if (this.#authorisation === null) return new Denial('check-unbound', UNAVAILABLE);
    return decisionOf(await this.#authorisation.check(context, declaration)) ?? context;
  }

  private deny(
    declaration: AccessDeclaration | null,
    context: CallContext,
    denial: Denial,
  ): Result<never, AccessDenied> {
    try {
      const actor = isMinted(context) ? context.actor : undefined;
      const rule = declaration?.rule;
      this.#logger.warn({
        msg: 'access.denied',
        useCase: declaration?.name ?? null,
        rule: rule?.kind ?? null,
        ...(rule?.kind === 'permissions' ? { keys: [...rule.allOf] } : {}),
        actor: actor?.kind ?? null,
        actorId: actor?.kind === 'authenticated' ? actor.accountId : null,
        marketId: isMinted(context) ? context.market.marketId : null,
        correlationId: isMinted(context) ? context.correlationId : null,
        reason: denial.reason,
        code: denial.answer.code,
      });
    } catch {
      // A failure to log never turns a denial into an admission.
    }
    return err(denial.answer);
  }
}

/**
 * Builds a gate. Imported only by `platform/authz/` (the module's provider) and by tests; a
 * dependency-cruiser rule refuses every other importer of this file.
 */
export function createUseCaseGate(
  markets: MarketRegistry,
  authorisation: AuthorisationCheck | null,
): UseCaseGate {
  return new UseCaseGate(CONSTRUCTION, markets, authorisation);
}

/** True only for a gate {@link createUseCaseGate} built: never a look-alike or a copy. */
export function isUseCaseGate(value: unknown): value is UseCaseGate {
  return typeof value === 'object' && value !== null && gates.has(value);
}
