import { err } from '@mondapac-drive/shared-kernel';
import type { CallContext, Result } from '@mondapac-drive/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { parseEmailAddress } from '../../domain/email-address';
import { MAX_PASSWORD_BYTES } from '../../domain/password-policy';
import type { FieldProblem } from '../field-problem';
import {
  SignInFlow,
  type SignInDependencies,
  type SignedIn,
  type SignInClient,
  type SignInRefusal,
} from '../sign-in/sign-in-flow';

export type { SignInClient } from '../sign-in/sign-in-flow';

export interface SignInCourierInput {
  readonly email: string;
  readonly password: string;
  readonly client: SignInClient;
}

/**
 * A new courier session. The token goes to the app in the answer's body only; the controller
 * never logs it.
 */
export type SignInCourierOutput = SignedIn;

export type SignInCourierFailure =
  | { readonly code: 'validation.failed'; readonly fields: readonly FieldProblem[] }
  | SignInRefusal;

export type SignInCourierDependencies = SignInDependencies;

/**
 * Courier sign-in from the app (identity design 3.5, 6.3, 6.8, 10.2; the marketplace's customer
 * sign-in with a bearer session). Rule `anonymous`: the gate passes the Market's anonymous actor
 * whoever calls (HF9). After the request's own checks, the steps of 6.3 run in
 * {@link SignInFlow}: the reservation unit, the hash outside any unit, the closing unit, which
 * opens a session of transport `bearer`.
 *
 * Refusals are `ok` outcomes of their units, so the counters and the record commit (PN1). An
 * unknown address, a wrong password, and another population or Market all answer
 * `credentials.invalid` (AC 1, AC 3).
 */
export class SignInCourier extends UseCase<
  SignInCourierInput,
  SignInCourierOutput,
  SignInCourierFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'identity.sign-in-courier',
    rule: { kind: 'anonymous' },
  };

  readonly #flow: SignInFlow;

  constructor(gate: UseCaseGate, deps: SignInCourierDependencies) {
    super(gate);
    this.#flow = new SignInFlow('courier', deps);
  }

  protected async handle(
    context: CallContext,
    input: SignInCourierInput,
  ): Promise<Result<SignInCourierOutput, SignInCourierFailure>> {
    const email = parseEmailAddress(input.email);
    if (!email.ok) {
      return err({ code: 'validation.failed', fields: [{ path: 'email', code: 'format' }] });
    }
    if (Buffer.byteLength(input.password, 'utf8') > MAX_PASSWORD_BYTES) {
      return err({ code: 'validation.failed', fields: [{ path: 'password', code: 'length' }] });
    }
    return this.#flow.run(context, email.value, input.password, input.client);
  }
}
