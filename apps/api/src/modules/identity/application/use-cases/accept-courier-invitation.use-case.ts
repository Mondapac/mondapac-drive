import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac-drive/shared-kernel';
import type {
  CallContext,
  Clock,
  Id,
  IdGenerator,
  Result,
  Temporal,
} from '@mondapac-drive/shared-kernel';
import type { AuditWriter } from '../../../../platform/audit/audit-writer';
import type { OutboxWriter } from '../../../../platform/events/outbox-writer';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { COURIER_ACCOUNT_INVITE } from '../../contracts/permissions';
import { Account } from '../../domain/account';
import { accountRoleAssigned, InvitationAcceptedAudit } from '../../domain/audit';
import { parseDisplayName } from '../../domain/display-name';
import type { Invitation } from '../../domain/invitation';
import {
  checkNewPassword,
  MAX_PASSWORD_BYTES,
  type PasswordRejected,
} from '../../domain/password-policy';
import { RoleAssignment } from '../../domain/role';
import { reservationVerdict } from '../../domain/throttle';
import type { AccountRepository } from '../ports/account.repository';
import type { CommonPasswordList } from '../ports/common-password-list';
import type { IdentityMarketPolicy } from '../ports/identity-market-policy';
import type { InvitationRepository } from '../ports/invitation.repository';
import type { PasswordHasher, PasswordHasherBusy } from '../ports/password-hasher';
import type { RoleAssignmentRepository, RoleRepository } from '../ports/role.repository';
import type { OpaqueTokens } from '../ports/second-factor-tokens';
import type { ThrottleKeys } from '../ports/session-secrets';
import type { ThrottleCounter, ThrottleRepository } from '../ports/throttle.repository';
import { readActingGrants, type ActingGrantDependencies } from '../roles/granting';
import type { SignInClient } from './sign-in-courier.use-case';
import type { FieldProblem } from '../field-problem';

export interface AcceptCourierInvitationInput {
  readonly token: string;
  readonly password: string;
  /** The name the courier gives (the sign-up rules of identity design 2.1, HF13). */
  readonly displayName: string;
  readonly client: SignInClient;
}

/** The courier's account exists; no session is opened: the courier signs in from the app. */
export interface AcceptCourierInvitationOutput {
  readonly code: 'invitation.accepted';
}

export type AcceptCourierInvitationFailure =
  | { readonly code: 'validation.failed'; readonly fields: readonly FieldProblem[] }
  | { readonly code: 'invitation.rejected' }
  | PasswordRejected
  | { readonly code: 'request.throttled'; readonly retryAfterSeconds: number }
  | PasswordHasherBusy
  | { readonly code: 'access.unavailable' };

export interface AcceptCourierInvitationDependencies extends ActingGrantDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly accounts: AccountRepository;
  readonly invitations: InvitationRepository;
  readonly roles: Pick<RoleRepository, 'findById'>;
  readonly assignments: Pick<RoleAssignmentRepository, 'add'>;
  readonly throttles: ThrottleRepository;
  readonly keys: ThrottleKeys;
  readonly invitationTokens: OpaqueTokens;
  readonly hasher: PasswordHasher;
  readonly commonPasswords: CommonPasswordList;
  readonly outbox: OutboxWriter;
  readonly audit: AuditWriter;
  readonly policy: IdentityMarketPolicy;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

const REJECTED = Object.freeze({ code: 'invitation.rejected' as const });
const UNAVAILABLE = Object.freeze({ code: 'access.unavailable' as const });

function acceptableInvitation(
  invitation: Invitation | null,
  now: Temporal.Instant,
): invitation is Invitation {
  return (
    invitation !== null &&
    invitation.state.kind === 'courier' &&
    invitation.usableAt(now) &&
    invitation.state.email !== null &&
    invitation.state.invitedByAccountId !== null
  );
}

/**
 * The invited courier accepts (Drive; the marketplace's Staff acceptance, identity design 3.4
 * `pending` → `accepted`). Rule `anonymous`: the invitation's token binds the request. The
 * courier gives a name and a password; the address is the invited one.
 *
 * 1. **Reservation unit**: `sign-in.origin` counted, the invitation read by its token's hash; one
 *    that is unknown, of another kind or Market, used, revoked or expired answers
 *    `invitation.rejected` and stays counted; a usable one gives the count back.
 * 2. Outside any unit: the name (HF13), the password's rules, then its hash (6.5).
 * 3. **Closing unit**, SERIALIZABLE: the invitation read again and still acceptable; its role
 *    still the courier system role; the inviter still an active, verified admin holding
 *    `identity.courier-account.invite` (Hassan 14.2). Then the account `active` and verified,
 *    the founding assignment of the courier role, the invitation accepted. Audit rows,
 *    `ANONYMOUS` bound to the invitation: `identity.invitation.accepted` and
 *    `identity.account-role.assigned` (courier scope, founding).
 *
 * Every refusal of the closing unit is `invitation.rejected`. The token, the password, the
 * address and the name are never logged.
 */
export class AcceptCourierInvitation extends UseCase<
  AcceptCourierInvitationInput,
  AcceptCourierInvitationOutput,
  AcceptCourierInvitationFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'identity.accept-courier-invitation',
    rule: { kind: 'anonymous' },
  };

  readonly #logger = new Logger('AcceptCourierInvitation');

  constructor(
    gate: UseCaseGate,
    private readonly deps: AcceptCourierInvitationDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: AcceptCourierInvitationInput,
  ): Promise<Result<AcceptCourierInvitationOutput, AcceptCourierInvitationFailure>> {
    const result = await this.accept(context, input);
    this.log('identity.accept-courier-invitation', context, {
      outcome: result.ok ? result.value.code : result.error.code,
    });
    return result;
  }

  private async accept(
    context: CallContext,
    input: AcceptCourierInvitationInput,
  ): Promise<Result<AcceptCourierInvitationOutput, AcceptCourierInvitationFailure>> {
    const { market } = context;
    const { unitOfWork, throttles, keys, policy } = this.deps;
    if (
      typeof input.password !== 'string' ||
      Buffer.byteLength(input.password, 'utf8') > MAX_PASSWORD_BYTES
    ) {
      return err({ code: 'validation.failed', fields: [{ path: 'password', code: 'length' }] });
    }
    const tokenHash = this.deps.invitationTokens.hashOf(input.token);
    const origin: ThrottleCounter = {
      kind: 'sign-in.origin',
      keyHash: keys.origin(market, input.client.origin),
      accountKey: null,
      rule: policy.signInThrottles(market).origin,
    };

    // 1. The reservation unit.
    type Reserved =
      | { readonly kind: 'refused'; readonly refusal: AcceptCourierInvitationFailure }
      | {
          readonly kind: 'reserved';
          readonly invitationId: Id<'Invitation'>;
          readonly email: string;
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
        if (!acceptableInvitation(invitation, now)) {
          return ok({ kind: 'refused', refusal: REJECTED });
        }
        await throttles.release(market, [reservation!]);
        return ok({
          kind: 'reserved',
          invitationId: invitation.state.id,
          email: invitation.state.email!.normalized,
        });
      });
      if (!run.ok) return err(UNAVAILABLE);
      reserved = run.value;
    } catch {
      this.log('identity.accept-courier-invitation.unavailable', context, {});
      return err(UNAVAILABLE);
    }
    if (reserved.kind === 'refused') return err(reserved.refusal);
    const { invitationId } = reserved;

    // 2. Outside any unit: checked only for a usable invitation, so it tells nothing of a token.
    const name = parseDisplayName(input.displayName);
    if (!name.ok) {
      return err({
        code: 'validation.failed',
        fields: [{ path: 'displayName', code: name.error.rule }],
      });
    }
    const displayName = name.value;
    const checked = checkNewPassword(
      input.password,
      policy.passwordRules(market),
      { email: reserved.email, displayName },
      (comparable) => this.deps.commonPasswords.isCommon(comparable),
    );
    if (!checked.ok) return err(checked.error);
    const hashed = await this.deps.hasher.hash(input.password);
    if (!hashed.ok) return err(hashed.error);

    // 3. The closing unit.
    const closed = await unitOfWork.run(
      market,
      async (): Promise<Result<Id<'Account'> | null, never>> => {
        const now = this.deps.clock.now();
        const invitation = await this.deps.invitations.findById(market, invitationId);
        if (!acceptableInvitation(invitation, now)) return ok(null);
        const role = await this.deps.roles.findById(market, invitation.state.roleId);
        if (role === null || role.state.scope !== 'courier' || !role.isSystem) return ok(null);
        const inviter = {
          accountId: invitation.state.invitedByAccountId!,
          population: 'admin' as const,
        };
        const standing = await readActingGrants(
          this.deps,
          market,
          inviter,
          [],
          [COURIER_ACCOUNT_INVITE.key],
        );
        if (standing === null) {
          this.log('identity.accept-courier-invitation.inviter-refused', context, {
            invitationId,
          });
          return ok(null);
        }
        const email = invitation.state.email!;
        if ((await this.deps.accounts.findByEmail(market, 'courier', email.normalized)) !== null) {
          return ok(null);
        }
        const account = Account.acceptInvitation({
          id: this.deps.ids.next<'Account'>(),
          marketId: market.marketId,
          population: 'courier',
          email,
          displayName,
          passwordHash: hashed.value,
          now,
        });
        const added = await this.deps.accounts.add(market, account);
        if (!added.ok) return ok(null);
        const accountId = account.state.id;
        await this.deps.assignments.add(
          market,
          RoleAssignment.found({
            id: this.deps.ids.next<'RoleAssignment'>(),
            account: { id: accountId, marketId: market.marketId, population: 'courier' },
            role,
            now,
          }),
        );
        if (!invitation.accept(accountId, now).ok) {
          throw new Error('AcceptCourierInvitation: an acceptable invitation refused acceptance');
        }
        await this.deps.invitations.save(market, invitation);
        await this.deps.outbox.append(context, invitation.pendingEvents);
        const roleId = role.state.id;
        const bound = { accountId, boundSubjectId: invitationId };
        await this.deps.audit.record(
          context,
          InvitationAcceptedAudit.entry(invitationId, {
            after: { kind: 'courier', roleId, ...bound },
          }),
        );
        await this.deps.audit.record(
          context,
          accountRoleAssigned(accountId, { ...bound, roleId, scope: 'courier', founding: true }),
        );
        return ok(accountId);
      },
      { isolation: 'serializable' },
    );
    if (!closed.ok || closed.value === null) return err(REJECTED);
    this.log('identity.accept-courier-invitation.accepted', context, {
      invitationId,
      accountId: closed.value,
    });
    return ok({ code: 'invitation.accepted' });
  }

  /** Ids and codes only: never the token, the password, the name or the address. */
  private log(msg: string, context: CallContext, fields: Record<string, string>): void {
    this.#logger.log({
      msg,
      ...fields,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
  }
}
