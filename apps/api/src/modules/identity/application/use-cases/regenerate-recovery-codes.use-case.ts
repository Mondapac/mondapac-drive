import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac-drive/shared-kernel';
import type { CallContext, Result } from '@mondapac-drive/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { RecoveryCodesRegeneratedAudit } from '../../domain/audit';
import { displayRecoveryCode, type RecoveryCode } from '../../domain/recovery-code';
import { newRecoveryCodes, spendCode } from '../second-factor/code-check';
import { SignedInFactorStep } from '../second-factor/signed-in-factor-step';
import {
  type FactorCodeInput,
  type FactorStepFailure,
  type FactorDeviceDependencies,
  codeField,
  logOutcome,
} from '../second-factor/factor-device';

/** Ten new recovery codes, shown once; every earlier one stopped working. */
export interface RegenerateRecoveryCodesOutput {
  readonly code: 'recovery-codes-regenerated';
  readonly recoveryCodes: readonly string[];
}

/**
 * Regenerates the holder's recovery codes (identity design 3.6, 7.3; slice 7b item E). Rule
 * `own-resources`. A code from the app or a recovery code proves the holder (spent once,
 * counted on `second-factor.account`); ten new codes are made and hashed outside any unit and
 * replace every earlier one in the closing unit; `identity.second-factor.recovery-codes-regenerated`
 * is written. No mail: it happens in front of the holder.
 */
export class RegenerateRecoveryCodes extends UseCase<
  FactorCodeInput,
  RegenerateRecoveryCodesOutput,
  FactorStepFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'identity.regenerate-recovery-codes',
    rule: { kind: 'own-resources' },
    // Admin accounts only: the step refuses any other population before a seller check matters.
  };

  readonly #logger = new Logger('RegenerateRecoveryCodes');
  readonly #step: SignedInFactorStep;

  constructor(
    gate: UseCaseGate,
    private readonly deps: FactorDeviceDependencies,
  ) {
    super(gate);
    this.#step = new SignedInFactorStep(deps, this.#logger, 'admin');
  }

  protected handle(
    context: CallContext,
    input: FactorCodeInput,
  ): Promise<Result<RegenerateRecoveryCodesOutput, FactorStepFailure>> {
    return regenerateRecoveryCodes(this.deps, this.#step, this.#logger, context, input);
  }
}

/**
 * Regenerates the recovery codes of the actor's own factor through the given step (the admin's
 * and the seller's use cases share it; each fixes the population its step serves).
 */
export async function regenerateRecoveryCodes(
  deps: FactorDeviceDependencies,
  step: SignedInFactorStep,
  logger: Logger,
  context: CallContext,
  input: FactorCodeInput,
): Promise<Result<RegenerateRecoveryCodesOutput, FactorStepFailure>> {
  const { market } = context;
  const presented = codeField(input.code, true);
  if (!presented.ok) return presented;
  const throttle = deps.policy.secondFactorThrottle(market);
  if (throttle === null) return err({ code: 'access.unavailable' });
  let fresh: { codes: readonly RecoveryCode[]; hashes: readonly Uint8Array[] } | null = null;
  const result = await step.run(context, presented.value, throttle, {
    secretOf: (factor) => factor.state.secretCiphertext,
    prepare: async (account) => {
      fresh = await newRecoveryCodes(deps.secrets, market, account.state.id);
    },
    spend: (factor, check, now) => spendCode(deps.factors, market, factor.state.id, check, now),
    succeed: async ({ account, factor, now }) => {
      const codes = fresh;
      if (codes === null || !factor.regenerateRecoveryCodes(codes.hashes, now).ok) {
        return err({ code: 'second-factor.unavailable' });
      }
      await deps.factors.save(market, factor);
      await deps.outbox.append(context, factor.pendingEvents);
      await deps.audit.record(
        context,
        RecoveryCodesRegeneratedAudit.entry(factor.state.id, {
          after: { accountId: account.state.id },
        }),
      );
      return ok({
        code: 'recovery-codes-regenerated' as const,
        recoveryCodes: codes.codes.map(displayRecoveryCode),
      });
    },
  });
  logOutcome(
    logger,
    'identity.recovery-codes.regenerate',
    context,
    result.ok ? result.value.code : result.error.code,
  );
  return result;
}
