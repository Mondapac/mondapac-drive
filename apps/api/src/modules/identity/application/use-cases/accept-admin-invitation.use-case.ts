import { Logger } from '@nestjs/common';
import { err, ok, Temporal } from '@mondapac-drive/shared-kernel';
import type { CallContext, Clock, Id, IdGenerator, Result } from '@mondapac-drive/shared-kernel';
import type { AuditWriter } from '../../../../platform/audit/audit-writer';
import type { OutboxWriter } from '../../../../platform/events/outbox-writer';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import {
  UseCase,
  type AccessDeclaration,
  type SealedPermissionCatalogue,
  type UseCaseGate,
} from '../../../../platform/authz';
import { Account } from '../../domain/account';
import {
  accountRoleAssigned,
  InvitationAcceptedAudit,
  SecondFactorActivatedAudit,
} from '../../domain/audit';
import { parseDisplayName } from '../../domain/display-name';
import { decodeBase32Secret } from '../../domain/otpauth';
import {
  checkNewPassword,
  MAX_PASSWORD_BYTES,
  type PasswordRejected,
} from '../../domain/password-policy';
import { displayRecoveryCode, type RecoveryCode } from '../../domain/recovery-code';
import { RoleAssignment, type Role } from '../../domain/role';
import { SecondFactor } from '../../domain/second-factor';
import { blockAfterFailure, reservationVerdict } from '../../domain/throttle';
import { candidateSteps, parseTotpCode } from '../../domain/totp';
import type { EffectiveKeyResolver } from '../access/effective-keys';
import type { AccountRepository } from '../ports/account.repository';
import type { CommonPasswordList } from '../ports/common-password-list';
import type { RoleGrantReader } from '../ports/role-grant-reader';
import { inviterMayStillGrant } from '../roles/granting';
import type { IdentityMarketPolicy } from '../ports/identity-market-policy';
import type { InvitationRepository } from '../ports/invitation.repository';
import type { PasswordHasher, PasswordHasherBusy } from '../ports/password-hasher';
import type { EnrolmentSecretTags, OpaqueTokens } from '../ports/second-factor-tokens';
import type { SecondFactorSecrets } from '../ports/second-factor-secrets';
import type { SecondFactorRepository } from '../ports/second-factor.repository';
import type { RoleAssignmentRepository, RoleRepository } from '../ports/role.repository';
import type { ThrottleKeys } from '../ports/session-secrets';
import type { ThrottleCounter, ThrottleRepository } from '../ports/throttle.repository';
import {
  newRecoveryCodes,
  reserveSecondFactor,
  secondFactorCounter,
  type ReservedAttempt,
} from '../second-factor/code-check';
import { acceptableAdminInvitation } from '../second-factor/invitation-lookup';
import type { SignInClient } from '../sign-in/sign-in-flow';
import type { FieldProblem } from '../field-problem';

export interface AcceptAdminInvitationInput {
  readonly token: string;
  readonly displayName: string;
  readonly password: string;
  /** The secret, its tag and its expiry, as the first request returned them. */
  readonly secret: string;
  readonly tag: string;
  readonly expiresAt: string;
  /** The first code from the app, for that secret. */
  readonly code: string;
  readonly client: SignInClient;
}

/** The account exists with an active factor. The recovery codes are shown once, here. */
export interface AcceptAdminInvitationOutput {
  readonly code: 'invitation.accepted';
  readonly accountId: Id<'Account'>;
  readonly recoveryCodes: readonly string[];
}

export type AcceptAdminInvitationFailure =
  | { readonly code: 'validation.failed'; readonly fields: readonly FieldProblem[] }
  | { readonly code: 'invitation.rejected' }
  /** The secret's tag does not match or its 15 minutes ended: start the acceptance again. */
  | { readonly code: 'invitation.enrolment-expired' }
  | PasswordRejected
  | { readonly code: 'second-factor.invalid' }
  | { readonly code: 'second-factor.locked'; readonly retryAfterSeconds: number }
  | { readonly code: 'request.throttled'; readonly retryAfterSeconds: number }
  | PasswordHasherBusy
  | { readonly code: 'access.unavailable' };

export interface AcceptAdminInvitationDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly accounts: AccountRepository;
  readonly invitations: InvitationRepository;
  readonly roles: RoleRepository;
  readonly assignments: RoleAssignmentRepository;
  /** Slice 8b: the inviter's grant, read in the closing unit. */
  readonly grants: RoleGrantReader;
  readonly effectiveKeys: EffectiveKeyResolver;
  readonly permissions: Pick<SealedPermissionCatalogue, 'get'>;
  readonly factors: SecondFactorRepository;
  readonly throttles: ThrottleRepository;
  readonly keys: ThrottleKeys;
  readonly invitationTokens: OpaqueTokens;
  readonly enrolmentTags: EnrolmentSecretTags;
  readonly secrets: SecondFactorSecrets;
  readonly hasher: PasswordHasher;
  readonly commonPasswords: CommonPasswordList;
  readonly outbox: OutboxWriter;
  readonly audit: AuditWriter;
  readonly policy: IdentityMarketPolicy;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

const REJECTED = Object.freeze({ code: 'invitation.rejected' as const });
const EXPIRED = Object.freeze({ code: 'invitation.enrolment-expired' as const });
const UNAVAILABLE = Object.freeze({ code: 'access.unavailable' as const });

/**
 * Accepts an admin invitation (identity design 3.4, 7.2, 7.4; HF5, HF6, HF13; AC 22, AC 29;
 * slice 7b items I, Hassan I-6; slice 8b). Rule `anonymous`: the invitation's token binds the
 * request. Two kinds of `admin` invitation: without an inviter (the first-admin routine, 7b), and
 * issued by an admin (8b), whose inviter is re-checked in the closing unit.
 *
 * 1. **Reservation unit**: `sign-in.origin` counted and the invitation read by the hash of its
 *    token (unusable: `invitation.rejected`, stays counted; usable: the count is given back),
 *    then the `second-factor.account` counter of the invited address reserved (HF2).
 * 2. Outside any unit: the secret's tag and expiry (`invitation.enrolment-expired`); the
 *    password's rules against the address and the new name (HF13); the first code against the
 *    presented secret with the steps of `candidateSteps(clock.now())` (I-2; a wrong code stays
 *    counted and blocks at the limit); the password's hash.
 * 3. **Closing unit**, SERIALIZABLE (the "no active Platform Administrator" rule spans rows, and
 *    it writes `role_assignments`, HF8): the invitation read again and still acceptable; **the
 *    role read again in the context Market** (I-6), a platform role. Without an inviter: still
 *    the Platform Administrator system role, refused once the Market has an active holder of it
 *    or any admin account (HF5). With an inviter (8b): the inviter still an active, verified
 *    admin of this Market who holds `identity.admin-account.invite` and could still grant the
 *    role (`GrantPolicy.canGrant` with its grant read in this unit; Hassan 14.2, I-2). Then the
 *    account created `active` and verified with the invited address (its data key with it), the
 *    secret sealed under that key, ten recovery codes hashed, the factor created `active` with
 *    the code's step spent (HF6), the assignment (founding without an inviter, granted by the
 *    inviter otherwise), the invitation accepted (its address and name cleared). Events:
 *    `invitation-accepted` and `second-factor-changed` (`activated`). Audit rows, `ANONYMOUS`
 *    bound to the invitation: `identity.invitation.accepted`, `identity.account-role.assigned`
 *    (platform scope, no seller, `founding` only without an inviter; only through its builder,
 *    I-7) and `identity.second-factor.activated`. No session opens: the new admin signs in.
 *
 * Every refusal of the closing unit is `invitation.rejected` (one answer for every cause).
 */
export class AcceptAdminInvitation extends UseCase<
  AcceptAdminInvitationInput,
  AcceptAdminInvitationOutput,
  AcceptAdminInvitationFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'identity.accept-admin-invitation',
    rule: { kind: 'anonymous' },
  };

  readonly #logger = new Logger('AcceptAdminInvitation');

  constructor(
    gate: UseCaseGate,
    private readonly deps: AcceptAdminInvitationDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: AcceptAdminInvitationInput,
  ): Promise<Result<AcceptAdminInvitationOutput, AcceptAdminInvitationFailure>> {
    const { market } = context;
    const { policy } = this.deps;

    // Shapes first: nothing is counted for a malformed request.
    const fields: FieldProblem[] = [];
    const displayName = parseDisplayName(input.displayName);
    if (!displayName.ok) fields.push({ path: 'displayName', code: displayName.error.rule });
    if (Buffer.byteLength(input.password, 'utf8') > MAX_PASSWORD_BYTES) {
      fields.push({ path: 'password', code: 'length' });
    }
    const secret = decodeBase32Secret(input.secret);
    if (secret === null) fields.push({ path: 'secret', code: 'format' });
    const expiresAt = parseInstant(input.expiresAt);
    if (expiresAt === null) fields.push({ path: 'expiresAt', code: 'format' });
    const code = parseTotpCode(input.code);
    if (code === null) fields.push({ path: 'code', code: 'format' });
    if (typeof input.tag !== 'string' || input.tag.length === 0 || input.tag.length > 128) {
      fields.push({ path: 'tag', code: 'format' });
    }
    if (
      !displayName.ok ||
      secret === null ||
      expiresAt === null ||
      code === null ||
      fields.length > 0
    ) {
      secret?.fill(0);
      return err({ code: 'validation.failed', fields });
    }
    const throttle = policy.secondFactorThrottle(market);
    if (throttle === null) {
      secret.fill(0);
      return err(UNAVAILABLE);
    }
    try {
      return await this.accept(context, input, {
        displayName: displayName.value,
        secret,
        expiresAt,
        code,
        throttle,
      });
    } finally {
      secret.fill(0);
    }
  }

  private async accept(
    context: CallContext,
    input: AcceptAdminInvitationInput,
    parsed: {
      readonly displayName: string;
      readonly secret: Uint8Array;
      readonly expiresAt: Temporal.Instant;
      readonly code: string;
      readonly throttle: NonNullable<ReturnType<IdentityMarketPolicy['secondFactorThrottle']>>;
    },
  ): Promise<Result<AcceptAdminInvitationOutput, AcceptAdminInvitationFailure>> {
    const { market } = context;
    const { unitOfWork, throttles, keys, policy } = this.deps;
    const tokenHash = this.deps.invitationTokens.hashOf(input.token);
    const origin: ThrottleCounter = {
      kind: 'sign-in.origin',
      keyHash: keys.origin(market, input.client.origin),
      accountKey: null,
      rule: policy.signInThrottles(market).origin,
    };

    // 1. The reservation unit.
    type Reserved =
      | { readonly kind: 'refused'; readonly refusal: AcceptAdminInvitationFailure }
      | {
          readonly kind: 'reserved';
          readonly invitationId: Id<'Invitation'>;
          readonly email: { readonly typed: string; readonly normalized: string };
          readonly attempt: ReservedAttempt;
        };
    let reserved: Reserved;
    try {
      const run = await unitOfWork.run(market, async (): Promise<Result<Reserved, never>> => {
        const now = this.deps.clock.now();
        const [reservation] = await throttles.reserve(market, [origin], now);
        const verdict = reservationVerdict([{ reservation: reservation!, rule: origin.rule }], now);
        if (!verdict.allowed) {
          return ok({
            kind: 'refused',
            refusal: { code: 'request.throttled', retryAfterSeconds: verdict.retryAfterSeconds },
          });
        }
        const invitation =
          tokenHash === null
            ? null
            : await this.deps.invitations.findByTokenHash(market, tokenHash);
        if (!acceptableAdminInvitation(invitation, now)) {
          return ok({ kind: 'refused', refusal: REJECTED });
        }
        await throttles.release(market, [reservation!]);
        const email = invitation.state.email!;
        const counter = secondFactorCounter(
          keys,
          market,
          'admin',
          email.normalized,
          parsed.throttle,
        );
        const attempt = await reserveSecondFactor(throttles, market, counter, now);
        if (attempt.kind === 'locked') {
          return ok({
            kind: 'refused',
            refusal: { code: 'second-factor.locked', retryAfterSeconds: attempt.retryAfterSeconds },
          });
        }
        return ok({
          kind: 'reserved',
          invitationId: invitation.state.id,
          email: { typed: email.typed, normalized: email.normalized },
          attempt: attempt.reserved,
        });
      });
      if (!run.ok) return err(UNAVAILABLE);
      reserved = run.value;
    } catch {
      this.log('identity.accept-invitation.unavailable', context, {});
      return err(UNAVAILABLE);
    }
    if (reserved.kind === 'refused') {
      this.log('identity.accept-invitation.refused', context, { reason: reserved.refusal.code });
      return err(reserved.refusal);
    }
    const { invitationId, email, attempt } = reserved;

    // 2. Outside any unit: the tag, the password's rules, the code, the hash.
    const now = this.deps.clock.now();
    if (
      Temporal.Instant.compare(now, parsed.expiresAt) >= 0 ||
      !this.deps.enrolmentTags.matches(
        market,
        invitationId,
        parsed.secret,
        parsed.expiresAt,
        input.tag,
      )
    ) {
      return this.releasing(context, attempt, EXPIRED);
    }
    const checked = checkNewPassword(
      input.password,
      policy.passwordRules(market),
      { email: email.normalized, displayName: parsed.displayName },
      (comparable) => this.deps.commonPasswords.isCommon(comparable),
    );
    if (!checked.ok) return this.releasing(context, attempt, checked.error);
    const step = this.deps.secrets.matchPlain(parsed.secret, parsed.code, candidateSteps(now));
    if (step === null) {
      const blocked = await this.quietly(context, () =>
        unitOfWork.run(market, async () => {
          const until = blockAfterFailure(attempt.reservation, attempt.rule, this.deps.clock.now());
          if (until !== null) {
            await throttles.block(market, [{ reservation: attempt.reservation, until }]);
          }
          return ok(undefined);
        }),
      );
      this.log('identity.accept-invitation.code-invalid', context, { invitationId });
      return err(blocked ? { code: 'second-factor.invalid' } : UNAVAILABLE);
    }
    const hashed = await this.deps.hasher.hash(input.password);
    if (!hashed.ok) return this.releasing(context, attempt, hashed.error);

    // 3. The closing unit.
    type Closed =
      | {
          readonly kind: 'accepted';
          readonly accountId: Id<'Account'>;
          readonly codes: readonly RecoveryCode[];
        }
      | { readonly kind: 'refused' };
    let closed: Result<Closed, never>;
    try {
      closed = await unitOfWork.run(
        market,
        async (): Promise<Result<Closed, never>> => {
          const now = this.deps.clock.now();
          const refuse = async (): Promise<Result<Closed, never>> => {
            await throttles.release(market, [attempt.reservation]);
            return ok({ kind: 'refused' });
          };
          const invitation = await this.deps.invitations.findById(market, invitationId);
          if (!acceptableAdminInvitation(invitation, now)) return refuse();
          // I-6: the role is read again, in the context Market, at this moment.
          const role = await this.deps.roles.findById(market, invitation.state.roleId);
          if (role === null || role.state.scope !== 'platform') {
            return refuse();
          }
          const inviterId = invitation.state.invitedByAccountId;
          if (inviterId === null) {
            // The first-admin path (7.4): only the Platform Administrator role.
            if (!role.isSystem) return refuse();
            // HF5: the first-admin path closes once the Market has an active administrator.
            if (await this.deps.assignments.hasActiveHolder(market, role.state.id)) {
              return refuse();
            }
            // Hassan L3 (PR #162): an invitation without an inviter is the first-admin path
            // only; once the Market has any admin account (in any state, as the issue rule of
            // 7.4), every other pending first-admin invitation is refused, never a second first
            // admin.
            if (await this.deps.accounts.existsInPopulation(market, 'admin')) return refuse();
          } else if (!(await this.inviterStillStands(context, inviterId, role))) {
            // Slice 8b (Hassan 14.2): the inviter is re-checked now, in this unit.
            return refuse();
          }
          const account = Account.acceptInvitation({
            id: this.deps.ids.next<'Account'>(),
            marketId: market.marketId,
            population: 'admin',
            email: invitation.state.email!,
            displayName: parsed.displayName,
            passwordHash: hashed.value,
            now,
          });
          const added = await this.deps.accounts.add(market, account);
          if (!added.ok) return refuse();
          const accountId = account.state.id;
          // The account's key exists in this unit only: sealing and hashing read it here.
          const sealed = await this.deps.secrets.seal(market, accountId, parsed.secret);
          const fresh = await newRecoveryCodes(this.deps.secrets, market, accountId);
          const factor = SecondFactor.createActive({
            id: this.deps.ids.next<'SecondFactor'>(),
            marketId: market.marketId,
            accountId,
            secretCiphertext: sealed,
            acceptedStep: step,
            recoveryCodeHashes: fresh.hashes,
            now,
          });
          await this.deps.factors.add(market, factor);
          const assigned = {
            id: accountId,
            marketId: market.marketId,
            population: 'admin',
          } as const;
          const assignmentId = this.deps.ids.next<'RoleAssignment'>();
          await this.deps.assignments.add(
            market,
            inviterId === null
              ? RoleAssignment.found({ id: assignmentId, account: assigned, role, now })
              : RoleAssignment.grant({
                  id: assignmentId,
                  account: assigned,
                  role,
                  assignedBy: inviterId,
                  now,
                }),
          );
          if (!invitation.accept(accountId, now).ok) {
            throw new Error('AcceptAdminInvitation: an acceptable invitation refused acceptance');
          }
          await this.deps.invitations.save(market, invitation);
          await this.deps.outbox.append(context, [
            ...invitation.pendingEvents,
            ...factor.pendingEvents,
          ]);
          const roleId = role.state.id;
          const bound = { accountId, boundSubjectId: invitationId };
          await this.deps.audit.record(
            context,
            InvitationAcceptedAudit.entry(invitationId, {
              after: { kind: 'admin', roleId, ...bound },
            }),
          );
          await this.deps.audit.record(
            context,
            accountRoleAssigned(accountId, {
              ...bound,
              roleId,
              scope: 'platform',
              founding: inviterId === null,
            }),
          );
          await this.deps.audit.record(
            context,
            SecondFactorActivatedAudit.entry(factor.state.id, { after: bound }),
          );
          await throttles.release(market, [attempt.reservation]);
          return ok({ kind: 'accepted', accountId, codes: fresh.codes });
        },
        { isolation: 'serializable' },
      );
    } catch (error) {
      this.log('identity.accept-invitation.closing-failed', context, { invitationId });
      await this.release(context, attempt);
      throw error;
    }
    if (!closed.ok || closed.value.kind === 'refused') {
      this.log('identity.accept-invitation.refused', context, {
        invitationId,
        reason: REJECTED.code,
      });
      return err(REJECTED);
    }
    this.log('identity.accept-invitation.accepted', context, {
      invitationId,
      accountId: closed.value.accountId,
    });
    return ok({
      code: 'invitation.accepted',
      accountId: closed.value.accountId,
      recoveryCodes: closed.value.codes.map(displayRecoveryCode),
    });
  }

  /**
   * Whether the inviter of an invitation could still issue it now (identity design 3.4 "the
   * inviter is still active and could still grant the role", Hassan 14.2; slice 8b), read in the
   * caller's serializable closing unit through the shared {@link inviterMayStillGrant}. A
   * disabled or demoted inviter cannot leave a role behind in a pending invitation.
   */
  private async inviterStillStands(
    context: CallContext,
    inviterId: Id<'Account'>,
    role: Role,
  ): Promise<boolean> {
    const checked = await inviterMayStillGrant(this.deps, context.market, inviterId, role);
    if (!checked.ok) {
      this.log('identity.accept-invitation.inviter-refused', context, { reason: checked.error });
    }
    return checked.ok;
  }

  /** Gives the attempt back (no code was tried) and answers `failure`. */
  private async releasing<F extends AcceptAdminInvitationFailure>(
    context: CallContext,
    attempt: ReservedAttempt,
    failure: F,
  ): Promise<Result<never, F | typeof UNAVAILABLE>> {
    return err((await this.release(context, attempt)) ? failure : UNAVAILABLE);
  }

  private release(context: CallContext, attempt: ReservedAttempt): Promise<boolean> {
    return this.quietly(context, () =>
      this.deps.unitOfWork.run(context.market, async () => {
        await this.deps.throttles.release(context.market, [attempt.reservation]);
        return ok(undefined);
      }),
    );
  }

  private async quietly(
    context: CallContext,
    run: () => Promise<Result<void, never>>,
  ): Promise<boolean> {
    try {
      return (await run()).ok;
    } catch {
      this.log('identity.accept-invitation.unit-unavailable', context, {});
      return false;
    }
  }

  /** Ids and codes only: never the token, the secret, the code, the name or the address. */
  private log(msg: string, context: CallContext, fields: Record<string, string>): void {
    this.#logger.log({
      msg,
      ...fields,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
  }
}

/** An ISO 8601 instant, or null. */
function parseInstant(raw: unknown): Temporal.Instant | null {
  if (typeof raw !== 'string' || raw.length > 40) return null;
  try {
    return Temporal.Instant.from(raw);
  } catch {
    return null;
  }
}
