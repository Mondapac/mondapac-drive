import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac-drive/shared-kernel';
import type { CallContext, Result } from '@mondapac-drive/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { encodeBase32, otpauthUri } from '../../domain/otpauth';
import { spendCode } from '../second-factor/code-check';
import { SignedInFactorStep } from '../second-factor/signed-in-factor-step';
import {
  type FactorCodeInput,
  type FactorStepFailure,
  type FactorDeviceDependencies,
  codeField,
  logOutcome,
} from '../second-factor/factor-device';

/** A new device's secret waits beside the active one (M13); shown once, here. */
export interface StartSecondFactorReplacementOutput {
  readonly code: 'second-factor-replacement-started';
  readonly secret: string;
  readonly otpauthUri: string;
}

/**
 * Starts replacing the admin's device (identity design 3.6 `active` → `active`, M13; slice 7b
 * item E). Rule `own-resources` (the actor's own factor; an admin only in 7b). A code from the
 * current app, or a recovery code, proves the holder ({@link SignedInFactorStep}: counted on
 * `second-factor.account`, spent once). A new 160-bit secret is sealed outside any unit and
 * waits in the factor's replacement field; the active secret keeps working until the new device
 * proves itself. A new start replaces a waiting secret. No mail and no audit row yet: the swap
 * is the change.
 */
export class StartSecondFactorReplacement extends UseCase<
  FactorCodeInput,
  StartSecondFactorReplacementOutput,
  FactorStepFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'identity.start-second-factor-replacement',
    rule: { kind: 'own-resources' },
    // Admin accounts only: the step refuses any other population before a seller check matters.
  };

  readonly #logger = new Logger('StartSecondFactorReplacement');
  readonly #step: SignedInFactorStep;

  constructor(
    gate: UseCaseGate,
    private readonly deps: FactorDeviceDependencies,
  ) {
    super(gate);
    this.#step = new SignedInFactorStep(deps, this.#logger, 'admin');
  }

  protected async handle(
    context: CallContext,
    input: FactorCodeInput,
  ): Promise<Result<StartSecondFactorReplacementOutput, FactorStepFailure>> {
    const { market } = context;
    const presented = codeField(input.code, true);
    if (!presented.ok) return presented;
    const throttle = this.deps.policy.secondFactorThrottle(market);
    if (throttle === null) return err({ code: 'access.unavailable' });
    let prepared: { sealed: string; secret: string; uri: string } | null = null;
    const result = await this.#step.run(context, presented.value, throttle, {
      secretOf: (factor) => factor.state.secretCiphertext,
      prepare: async (account) => {
        const secret = this.deps.secrets.newSecret();
        try {
          prepared = {
            sealed: await this.deps.secrets.seal(market, account.state.id, secret),
            secret: encodeBase32(secret),
            uri: otpauthUri({
              issuer: this.deps.policy.mailSender(market).name,
              accountName: account.state.email.typed,
              secret,
            }),
          };
        } finally {
          secret.fill(0);
        }
      },
      spend: (factor, check, now) =>
        spendCode(this.deps.factors, market, factor.state.id, check, now),
      succeed: async ({ factor }) => {
        const ready = prepared;
        if (ready === null || !factor.startReplacement(ready.sealed).ok) {
          return err({ code: 'second-factor.unavailable' });
        }
        await this.deps.factors.save(market, factor);
        return ok({
          code: 'second-factor-replacement-started' as const,
          secret: ready.secret,
          otpauthUri: ready.uri,
        });
      },
    });
    logOutcome(
      this.#logger,
      'identity.second-factor-replacement.start',
      context,
      result.ok ? result.value.code : result.error.code,
    );
    return result;
  }
}
