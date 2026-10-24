import { err, ok } from '@mondapac-drive/shared-kernel';
import type { CallContext, Clock, Result } from '@mondapac-drive/shared-kernel';
import type { OutboxWriter } from '../../../../platform/events/outbox-writer';
import { StaleAggregateError } from '../../../../platform/unit-of-work/errors';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { parseDisplayName } from '../../domain/display-name';
import type { AccountRepository } from '../ports/account.repository';
import type { FieldProblem } from '../field-problem';

export interface ChangeDisplayNameInput {
  /** As typed; parsed here (trimmed, 1 to 100 characters, no URL-like text). */
  readonly displayName: string;
}

export interface ChangeDisplayNameOutput {
  readonly code: 'display-name-changed';
  /** False when the name was already the one given: nothing was written. */
  readonly changed: boolean;
}

export type ChangeDisplayNameFailure =
  | { readonly code: 'validation.failed'; readonly fields: readonly FieldProblem[] }
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' };

export interface ChangeDisplayNameDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly accounts: AccountRepository;
  readonly outbox: OutboxWriter;
  readonly clock: Clock;
}

const UNAVAILABLE = Object.freeze({ code: 'access.unavailable' as const });

/**
 * A signed-in admin or courier changes the own display name (profile package). Rule
 * `own-resources`; a merchant's integration account is named by the operator, never here. The account is the actor's: nothing in the input names one, so nobody can rename
 * another account through this use case. One
 * read-write unit under the account's version; a concurrent change of the same account answers
 * `access.unavailable` and the holder repeats it. Records
 * `identity.account-display-name-changed.v1` (ids and codes only: the name is personal data).
 * No code is asked for: a name change gives no access to anything.
 */
export class ChangeDisplayName extends UseCase<
  ChangeDisplayNameInput,
  ChangeDisplayNameOutput,
  ChangeDisplayNameFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'identity.change-display-name',
    rule: { kind: 'own-resources' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: ChangeDisplayNameDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: ChangeDisplayNameInput,
  ): Promise<Result<ChangeDisplayNameOutput, ChangeDisplayNameFailure>> {
    const { market, actor } = context;
    // The gate admits only an authenticated actor under own-resources.
    if (actor.kind !== 'authenticated' || actor.population === 'merchant') {
      return err({ code: 'access.denied' });
    }
    const name = parseDisplayName(input.displayName);
    if (!name.ok) {
      return err({
        code: 'validation.failed',
        fields: [{ path: 'displayName', code: name.error.rule }],
      });
    }
    try {
      const done = await this.deps.unitOfWork.run(
        market,
        async (): Promise<Result<ChangeDisplayNameOutput, ChangeDisplayNameFailure>> => {
          const account = await this.deps.accounts.findById(market, actor.accountId);
          if (account === null || account.state.population !== actor.population) {
            return err({ code: 'access.denied' });
          }
          const renamed = account.rename({
            displayName: name.value,
            now: this.deps.clock.now(),
          });
          if (!renamed.ok) return err({ code: 'access.denied' });
          if (renamed.value) {
            await this.deps.accounts.save(market, account);
            await this.deps.outbox.append(context, account.pendingEvents);
          }
          return ok({ code: 'display-name-changed', changed: renamed.value });
        },
      );
      return done;
    } catch (error) {
      if (error instanceof StaleAggregateError) return err(UNAVAILABLE);
      throw error;
    }
  }
}
