import { err, ok } from '@mondapac-drive/shared-kernel';
import type { CallContext, Result } from '@mondapac-drive/shared-kernel';
import { StaleAggregateError } from '../../../../platform/unit-of-work/errors';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { parsePanelLanguage, parseTimezone } from '../../domain/panel-preferences';
import type { AccountRepository } from '../ports/account.repository';
import type { FieldProblem } from '../field-problem';

export interface ChangePanelPreferencesInput {
  /** An IANA zone id, or null to follow the panel's own rule. */
  readonly timezone: string | null;
  /** A language from `PANEL_LANGUAGES`, or null for the Market's language. */
  readonly locale: string | null;
}

export interface ChangePanelPreferencesOutput {
  readonly code: 'panel-preferences-changed';
  /** False when the values were already the ones given: nothing was written. */
  readonly changed: boolean;
}

export type ChangePanelPreferencesFailure =
  | { readonly code: 'validation.failed'; readonly fields: readonly FieldProblem[] }
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' };

export interface ChangePanelPreferencesDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly accounts: AccountRepository;
}

const UNAVAILABLE = Object.freeze({ code: 'access.unavailable' as const });

/**
 * A signed-in admin or courier sets the own time zone and language (profile package 3). Rule
 * `own-resources`; a merchant's integration account has none to set. The
 * account is the actor's: the input names none. No code is asked for: a display preference gives
 * access to nothing. A concurrent change of the same account answers `access.unavailable` and
 * the holder repeats it.
 */
export class ChangePanelPreferences extends UseCase<
  ChangePanelPreferencesInput,
  ChangePanelPreferencesOutput,
  ChangePanelPreferencesFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'identity.change-panel-preferences',
    rule: { kind: 'own-resources' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: ChangePanelPreferencesDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: ChangePanelPreferencesInput,
  ): Promise<Result<ChangePanelPreferencesOutput, ChangePanelPreferencesFailure>> {
    const { market, actor } = context;
    if (actor.kind !== 'authenticated') return err({ code: 'access.denied' });
    if (actor.population === 'merchant') return err({ code: 'access.denied' });
    const timezone = parseTimezone(input.timezone);
    const locale = parsePanelLanguage(input.locale);
    const fields: FieldProblem[] = [];
    if (!timezone.ok) fields.push({ path: 'timezone', code: 'invalid' });
    if (!locale.ok) fields.push({ path: 'locale', code: 'invalid' });
    if (!timezone.ok || !locale.ok) return err({ code: 'validation.failed', fields });
    try {
      return await this.deps.unitOfWork.run(
        market,
        async (): Promise<Result<ChangePanelPreferencesOutput, ChangePanelPreferencesFailure>> => {
          const account = await this.deps.accounts.findById(market, actor.accountId);
          if (account === null || account.state.population !== actor.population) {
            return err({ code: 'access.denied' });
          }
          const set = account.setPreferences({ timezone: timezone.value, locale: locale.value });
          if (!set.ok) return err({ code: 'access.denied' });
          if (set.value) await this.deps.accounts.save(market, account);
          return ok({ code: 'panel-preferences-changed', changed: set.value });
        },
      );
    } catch (error) {
      if (error instanceof StaleAggregateError) return err(UNAVAILABLE);
      throw error;
    }
  }
}
