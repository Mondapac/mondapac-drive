import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac-drive/shared-kernel';
import type { CallContext, Clock, Result, Temporal } from '@mondapac-drive/shared-kernel';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { encodeBase32, otpauthUri } from '../../domain/otpauth';
import { reservationVerdict } from '../../domain/throttle';
import type { IdentityMarketPolicy } from '../ports/identity-market-policy';
import type { InvitationRepository } from '../ports/invitation.repository';
import type { EnrolmentSecretTags, OpaqueTokens } from '../ports/second-factor-tokens';
import type { SecondFactorSecrets } from '../ports/second-factor-secrets';
import type { ThrottleKeys } from '../ports/session-secrets';
import type { ThrottleCounter, ThrottleRepository } from '../ports/throttle.repository';
import {
  acceptableAdminInvitation,
  ENROLMENT_SECRET_MINUTES,
} from '../second-factor/invitation-lookup';
import type { SignInClient } from '../sign-in/sign-in-flow';

export interface StartAdminInvitationAcceptanceInput {
  /** The token from the fragment of the invitation's link. */
  readonly token: string;
  readonly client: SignInClient;
}

/**
 * The first request of an admin's acceptance (identity design 3.4, HF6): a new secret, shown as
 * base32 and in the `otpauth://` URI, with its tag and expiry. Nothing is stored: the request
 * that accepts presents all three back with the first code.
 */
export interface StartAdminInvitationAcceptanceOutput {
  readonly code: 'invitation.enrolment-ready';
  readonly secret: string;
  readonly otpauthUri: string;
  readonly tag: string;
  readonly expiresAt: Temporal.Instant;
}

export type StartAdminInvitationAcceptanceFailure =
  | { readonly code: 'invitation.rejected' }
  | { readonly code: 'request.throttled'; readonly retryAfterSeconds: number }
  | { readonly code: 'access.unavailable' };

export interface StartAdminInvitationAcceptanceDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly invitations: InvitationRepository;
  readonly throttles: ThrottleRepository;
  readonly keys: ThrottleKeys;
  readonly invitationTokens: OpaqueTokens;
  readonly secrets: SecondFactorSecrets;
  readonly enrolmentTags: EnrolmentSecretTags;
  readonly policy: IdentityMarketPolicy;
  readonly clock: Clock;
}

const REJECTED = Object.freeze({ code: 'invitation.rejected' as const });

/**
 * Starts the acceptance of an admin invitation (identity design 3.4, 7.1, 7.4; HF6; AC 22; slice
 * 7b). Rule `anonymous`: the invitation's token is the credential. One short unit counts the
 * request on `sign-in.origin` (HF3: token guesses are bounded per origin) and reads the
 * invitation by the hash of its token; anything but a dispatched, pending, unexpired `admin`
 * invitation with no inviter answers `invitation.rejected` and stays counted; a usable one gives
 * the count back. Then, outside any unit, a new 160-bit secret and its tag (HMAC under a key
 * derived from the stack secret, bound to the Market, the invitation, the secret and an expiry
 * {@link ENROLMENT_SECRET_MINUTES} minutes ahead) are returned. Nothing is stored; leaving here
 * creates nothing. The secret and the token are never logged.
 */
export class StartAdminInvitationAcceptance extends UseCase<
  StartAdminInvitationAcceptanceInput,
  StartAdminInvitationAcceptanceOutput,
  StartAdminInvitationAcceptanceFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'identity.start-admin-invitation-acceptance',
    rule: { kind: 'anonymous' },
  };

  readonly #logger = new Logger('StartAdminInvitationAcceptance');

  constructor(
    gate: UseCaseGate,
    private readonly deps: StartAdminInvitationAcceptanceDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: StartAdminInvitationAcceptanceInput,
  ): Promise<Result<StartAdminInvitationAcceptanceOutput, StartAdminInvitationAcceptanceFailure>> {
    const { market } = context;
    const { unitOfWork, throttles, keys, policy } = this.deps;
    const tokenHash = this.deps.invitationTokens.hashOf(input.token);
    const counter: ThrottleCounter = {
      kind: 'sign-in.origin',
      keyHash: keys.origin(market, input.client.origin),
      accountKey: null,
      rule: policy.signInThrottles(market).origin,
    };
    type Found = {
      readonly invitationId: string | null;
      readonly email: string | null;
      readonly throttled: number | null;
    };
    let found: Found;
    try {
      const run = await unitOfWork.run(market, async (): Promise<Result<Found, never>> => {
        const now = this.deps.clock.now();
        const [reservation] = await throttles.reserve(market, [counter], now);
        const verdict = reservationVerdict(
          [{ reservation: reservation!, rule: counter.rule }],
          now,
        );
        if (!verdict.allowed) {
          return ok({ invitationId: null, email: null, throttled: verdict.retryAfterSeconds });
        }
        const invitation =
          tokenHash === null
            ? null
            : await this.deps.invitations.findByTokenHash(market, tokenHash);
        if (!acceptableAdminInvitation(invitation, now)) {
          return ok({ invitationId: null, email: null, throttled: null });
        }
        // A usable token is not a guess.
        await throttles.release(market, [reservation!]);
        return ok({
          invitationId: invitation.state.id,
          email: invitation.state.email!.typed,
          throttled: null,
        });
      });
      if (!run.ok) return err({ code: 'access.unavailable' });
      found = run.value;
    } catch {
      this.log('identity.invitation-acceptance.unavailable', context, {});
      return err({ code: 'access.unavailable' });
    }
    if (found.throttled !== null) {
      return err({ code: 'request.throttled', retryAfterSeconds: found.throttled });
    }
    if (found.invitationId === null || found.email === null) {
      this.log('identity.invitation-acceptance.rejected', context, {});
      return err(REJECTED);
    }
    const invitationId = found.invitationId as Parameters<EnrolmentSecretTags['tag']>[1];
    const expiresAt = this.deps.clock.now().add({ minutes: ENROLMENT_SECRET_MINUTES });
    const secret = this.deps.secrets.newSecret();
    try {
      const output: StartAdminInvitationAcceptanceOutput = {
        code: 'invitation.enrolment-ready',
        secret: encodeBase32(secret),
        otpauthUri: otpauthUri({
          issuer: policy.mailSender(market).name,
          accountName: found.email,
          secret,
        }),
        tag: this.deps.enrolmentTags.tag(market, invitationId, secret, expiresAt),
        expiresAt,
      };
      this.log('identity.invitation-acceptance.started', context, { invitationId });
      return ok(output);
    } finally {
      secret.fill(0);
    }
  }

  /** Ids and codes only: never the token, the secret or the address (P 12.3). */
  private log(msg: string, context: CallContext, fields: Record<string, string>): void {
    this.#logger.log({
      msg,
      ...fields,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
  }
}
