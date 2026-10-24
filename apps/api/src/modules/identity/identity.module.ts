import { Module, type FactoryProvider, type InjectionToken } from '@nestjs/common';
import type { Clock } from '@mondapac-drive/shared-kernel';
import {
  AUTHENTICATOR,
  AUTHORISATION_CHECK,
  PermissionRegistry,
  registerPermissions,
  USE_CASE_GATE,
  type UseCaseGate,
} from '../../platform/authz';
import { registerAuditActions } from '../../platform/audit/audit-action-catalogue';
import { AUDIT_WRITER } from '../../platform/audit/audit-writer';
import { CLOCK } from '../../platform/clock/clock.module';
import { registerEvents } from '../../platform/events/event-catalogue';
import { registerSubscriptionsFrom } from '../../platform/events/event-subscriptions';
import { OUTBOX_WRITER } from '../../platform/events/outbox-writer';
import { ID_GENERATOR } from '../../platform/ids/ids.module';
import { MAIL_TRANSPORT } from '../../platform/mail/mail-transport';
import { MarketRegistry } from '../../platform/market-config/market-registry';
import { PersistenceModule } from '../../platform/persistence/persistence.module';
import { registerJobsFrom } from '../../platform/scheduler/job-registry';
import { UNIT_OF_WORK, type UnitOfWork } from '../../platform/unit-of-work/unit-of-work';
import { AccountAuthorisationCheck } from './application/access/account-authorisation-check';
import {
  EFFECTIVE_KEY_RESOLVER,
  type EffectiveKeyResolver,
} from './application/access/effective-keys';
import { SessionAuthenticator } from './application/access/session-authenticator';
import type { RoleEditorDependencies } from './application/roles/role-editor';
import { ACCOUNT_REPOSITORY, type AccountRepository } from './application/ports/account.repository';
import { ADMIN_ACCOUNT_READER } from './application/ports/admin-account-reader';
import { COMMON_PASSWORD_LIST } from './application/ports/common-password-list';
import { IDENTITY_MAIL_COMPOSER } from './application/ports/identity-mails';
import { IDENTITY_MARKET_POLICY } from './application/ports/identity-market-policy';
import { INVITATION_REPOSITORY } from './application/ports/invitation.repository';
import { LINK_TARGETS, LINK_TOKENS } from './application/ports/link-secrets';
import {
  MERCHANT_MEMBERSHIP_REPOSITORY,
  MERCHANT_REPOSITORY,
  type MerchantMembershipRepository,
  type MerchantRepository,
} from './application/ports/merchant.repository';
import { ONE_TIME_LINK_REPOSITORY } from './application/ports/one-time-link.repository';
import { PASSWORD_HASHER } from './application/ports/password-hasher';
import { ROLE_GRANT_READER, type RoleGrantReader } from './application/ports/role-grant-reader';
import { ROLE_SEED } from './application/ports/role-seed';
import { ROLE_ASSIGNMENT_REPOSITORY, ROLE_REPOSITORY } from './application/ports/role.repository';
import { SESSION_REPOSITORY, type SessionRepository } from './application/ports/session.repository';
import {
  SESSION_TOKENS,
  THROTTLE_KEYS,
  type SessionTokens,
} from './application/ports/session-secrets';
import {
  CHALLENGE_TOKENS,
  ENROLMENT_SECRET_TAGS,
  INVITATION_TOKENS,
} from './application/ports/second-factor-tokens';
import { SECOND_FACTOR_SECRETS } from './application/ports/second-factor-secrets';
import { SECOND_FACTOR_REPOSITORY } from './application/ports/second-factor.repository';
import { SIGN_IN_CHALLENGE_REPOSITORY } from './application/ports/sign-in-challenge.repository';
import { SIGN_IN_RECORD_REPOSITORY } from './application/ports/sign-in-record.repository';
import { THROTTLE_REPOSITORY } from './application/ports/throttle.repository';
import { AcceptAdminInvitation } from './application/use-cases/accept-admin-invitation.use-case';
import { AcceptCourierInvitation } from './application/use-cases/accept-courier-invitation.use-case';
import { AssignAdminRole } from './application/use-cases/assign-admin-role.use-case';
import { ChangeDisplayName } from './application/use-cases/change-display-name.use-case';
import {
  ReinstateMerchant,
  SuspendMerchant,
} from './application/use-cases/change-merchant-state.use-case';
import { ChangePanelPreferences } from './application/use-cases/change-panel-preferences.use-case';
import { ChangePassword } from './application/use-cases/change-password.use-case';
import { CompleteAdminSignIn } from './application/use-cases/complete-admin-sign-in.use-case';
import { CompleteSecondFactorReplacement } from './application/use-cases/complete-second-factor-replacement.use-case';
import { ConfirmSecondFactorEnrolment } from './application/use-cases/confirm-second-factor-enrolment.use-case';
import { ContactEmailOf } from './application/use-cases/contact-email-of.use-case';
import { IsActiveCourier } from './application/use-cases/is-active-courier.use-case';
import { CreateMerchant } from './application/use-cases/create-merchant.use-case';
import { CreatePlatformRole } from './application/use-cases/create-platform-role.use-case';
import { DeletePlatformRole } from './application/use-cases/delete-platform-role.use-case';
import { DescribeActor } from './application/use-cases/describe-actor.use-case';
import { DisableAdminAccount } from './application/use-cases/disable-admin-account.use-case';
import { DisableCourierAccount } from './application/use-cases/disable-courier-account.use-case';
import { EditPlatformRole } from './application/use-cases/edit-platform-role.use-case';
import { EnableAdminAccount } from './application/use-cases/enable-admin-account.use-case';
import { EnableCourierAccount } from './application/use-cases/enable-courier-account.use-case';
import { InviteAdmin } from './application/use-cases/invite-admin.use-case';
import { InviteCourier } from './application/use-cases/invite-courier.use-case';
import { IssueFirstAdminInvitation } from './application/use-cases/issue-first-admin-invitation.use-case';
import { ListAdminTeam } from './application/use-cases/list-admin-team.use-case';
import { ListMerchants } from './application/use-cases/list-merchants.use-case';
import { ListOwnSessions } from './application/use-cases/list-own-sessions.use-case';
import { ListPlatformRoles } from './application/use-cases/list-platform-roles.use-case';
import {
  IssueMerchantApiKey,
  ListMerchantApiKeys,
  RevokeMerchantApiKey,
} from './application/use-cases/merchant-api-keys.use-case';
import { PurgeExpired } from './application/use-cases/purge-expired.use-case';
import { RegenerateRecoveryCodes } from './application/use-cases/regenerate-recovery-codes.use-case';
import { RequestPasswordReset } from './application/use-cases/request-password-reset.use-case';
import { ResendAdminInvitation } from './application/use-cases/resend-admin-invitation.use-case';
import { ResetAdminSecondFactor } from './application/use-cases/reset-admin-second-factor.use-case';
import { ResetOtherAdminSecondFactor } from './application/use-cases/reset-other-admin-second-factor.use-case';
import { ResetPassword } from './application/use-cases/reset-password.use-case';
import { RevokeAdminInvitation } from './application/use-cases/revoke-admin-invitation.use-case';
import { SeedRoles } from './application/use-cases/seed-roles.use-case';
import { SendInvitationMail } from './application/use-cases/send-invitation-mail.use-case';
import { SendLinkMail } from './application/use-cases/send-link-mail.use-case';
import { SendOtherSessionsSignedOutMail } from './application/use-cases/send-other-sessions-signed-out-mail.use-case';
import { SendPasswordChangedMail } from './application/use-cases/send-password-changed-mail.use-case';
import { SendSecondFactorMail } from './application/use-cases/send-second-factor-mail.use-case';
import { SignInAdmin } from './application/use-cases/sign-in-admin.use-case';
import { SignInCourier } from './application/use-cases/sign-in-courier.use-case';
import { SignOutOtherSessions } from './application/use-cases/sign-out-other-sessions.use-case';
import { SignOut } from './application/use-cases/sign-out.use-case';
import { StartAdminInvitationAcceptance } from './application/use-cases/start-admin-invitation-acceptance.use-case';
import { StartSecondFactorEnrolment } from './application/use-cases/start-second-factor-enrolment.use-case';
import { StartSecondFactorReplacement } from './application/use-cases/start-second-factor-replacement.use-case';
import { IDENTITY_FACADE } from './contracts/identity.facade';
import { IDENTITY_PERMISSIONS } from './contracts/permissions';
import { IDENTITY_AUDIT_ACTIONS } from './domain/audit';
import { IDENTITY_EVENTS } from './domain/events';
import { accountRepositoryProvider } from './infrastructure/account-repository.provider';
import { adminAccountReaderProvider } from './infrastructure/admin-team/prisma-admin-account-reader';
import { linkProviders } from './infrastructure/links/link-providers';
import { MarketConfigIdentityPolicy } from './infrastructure/market-config-identity-policy';
import { merchantProviders } from './infrastructure/merchants/merchant-providers';
import { Argon2idPasswordHasher } from './infrastructure/passwords/argon2id-password-hasher';
import { CheckedInCommonPasswords } from './infrastructure/passwords/checked-in-common-passwords';
import { roleProviders } from './infrastructure/roles/role-providers';
import { secondFactorProviders } from './infrastructure/second-factor/second-factor-providers';
import { sessionProviders } from './infrastructure/sessions/session-providers';
import {
  AdminCouriersController,
  AdminMerchantsController,
} from './presentation/admin-merchants.controller';
import { AdminPasswordController } from './presentation/admin-password.controller';
import { AdminSecondFactorController } from './presentation/admin-second-factor.controller';
import { AdminSessionController } from './presentation/admin-session.controller';
import { AdminTeamController } from './presentation/admin-team.controller';
import { CourierSessionController } from './presentation/courier-session.controller';
import { IdentityFacadeImplementation } from './presentation/identity.facade';
import { purgeExpiredJob } from './presentation/jobs/purge-expired.job';
import { seedRolesJob } from './presentation/jobs/seed-roles.job';
import {
  AdminProfileController,
  CourierProfileController,
} from './presentation/profile.controller';
import { identityMailSubscriptions } from './presentation/subscribers/mail.subscriptions';

/**
 * The Nest token of each dependency name the use cases of identity share: a use case's
 * dependency object is built from these by {@link useCaseProvider}, so a name always means the
 * same port.
 */
const PORT = {
  unitOfWork: UNIT_OF_WORK,
  accounts: ACCOUNT_REPOSITORY,
  adminAccounts: ADMIN_ACCOUNT_READER,
  sessions: SESSION_REPOSITORY,
  throttles: THROTTLE_REPOSITORY,
  records: SIGN_IN_RECORD_REPOSITORY,
  links: ONE_TIME_LINK_REPOSITORY,
  challenges: SIGN_IN_CHALLENGE_REPOSITORY,
  invitations: INVITATION_REPOSITORY,
  merchants: MERCHANT_REPOSITORY,
  memberships: MERCHANT_MEMBERSHIP_REPOSITORY,
  roles: ROLE_REPOSITORY,
  assignments: ROLE_ASSIGNMENT_REPOSITORY,
  grants: ROLE_GRANT_READER,
  effectiveKeys: EFFECTIVE_KEY_RESOLVER,
  permissions: PermissionRegistry,
  seed: ROLE_SEED,
  hasher: PASSWORD_HASHER,
  commonPasswords: COMMON_PASSWORD_LIST,
  tokens: SESSION_TOKENS,
  sessionTokens: SESSION_TOKENS,
  keys: THROTTLE_KEYS,
  linkTokens: LINK_TOKENS,
  targets: LINK_TARGETS,
  composer: IDENTITY_MAIL_COMPOSER,
  transport: MAIL_TRANSPORT,
  outbox: OUTBOX_WRITER,
  audit: AUDIT_WRITER,
  policy: IDENTITY_MARKET_POLICY,
  clock: CLOCK,
  ids: ID_GENERATOR,
  factors: SECOND_FACTOR_REPOSITORY,
  secrets: SECOND_FACTOR_SECRETS,
  challengeTokens: CHALLENGE_TOKENS,
  invitationTokens: INVITATION_TOKENS,
  enrolmentTags: ENROLMENT_SECRET_TAGS,
} as const satisfies Record<string, InjectionToken>;

type PortName = keyof typeof PORT;

/** The ports of every merchant use case (`application/merchants/merchant-admin.ts`). */
const MERCHANT_ADMIN_PORTS = {
  unitOfWork: true,
  accounts: true,
  grants: true,
  effectiveKeys: true,
  merchants: true,
  memberships: true,
  sessions: true,
  sessionTokens: true,
  audit: true,
  policy: true,
  clock: true,
  ids: true,
} as const;

/** The provider of one of the three use cases of the role editor (slice 10): one dependency set. */
function roleEditorProvider<U>(
  type: new (gate: UseCaseGate, deps: RoleEditorDependencies) => U,
): FactoryProvider<U> {
  return useCaseProvider(type, {
    unitOfWork: true,
    accounts: true,
    roles: true,
    assignments: true,
    grants: true,
    effectiveKeys: true,
    permissions: true,
    policy: true,
    outbox: true,
    audit: true,
    clock: true,
    ids: true,
  });
}

/**
 * The provider of one use case: the gate and the named ports, in a dependency object. `ports`
 * names every key of the use case's own dependency type, each a key of {@link PORT}, and no
 * other: the type checker refuses a missing, unknown or misnamed dependency.
 */
function useCaseProvider<D, U>(
  type: new (gate: UseCaseGate, deps: D) => U,
  ports: { readonly [K in keyof D]-?: K extends PortName ? true : never },
): FactoryProvider<U> {
  const names = Object.keys(ports) as PortName[];
  return {
    provide: type,
    inject: [USE_CASE_GATE, ...names.map((name) => PORT[name])],
    useFactory: (gate: UseCaseGate, ...values: unknown[]) =>
      new type(gate, Object.fromEntries(names.map((name, index) => [name, values[index]])) as D),
  };
}

/**
 * The identity bounded context of Drive, copied from the marketplace (commit a87dd54f; its
 * identity design and ADR-0018) and cut to Drive's three populations:
 *
 * - **admin** (operators and dispatchers): cookie sessions with CSRF, a second factor, the
 *   platform roles (Platform Administrator, operator, dispatcher and custom roles), the admin
 *   team, invitations and the role editor, as in the marketplace.
 * - **courier**: invited by a dispatcher, signs in from the app with a bearer session whose token
 *   is answered in the body; one system role holding every courier key.
 * - **merchant**: never signs in. An operator creates the merchant with its integration account
 *   and issues API keys: sessions of that account with transport `api-key`, scoped to the Market
 *   and the merchant. One system role holding every merchant key.
 *
 * Exports the `Authenticator` (the actor guard) and the `AuthorisationCheck` (the gate, through
 * `AuthzModule.register(IdentityModule)`), and the facade other modules read.
 */
@Module({
  controllers: [
    AdminSessionController,
    AdminSecondFactorController,
    AdminPasswordController,
    AdminProfileController,
    AdminTeamController,
    AdminCouriersController,
    AdminMerchantsController,
    CourierSessionController,
    CourierProfileController,
  ],
  providers: [
    PersistenceModule.outboxWriterFor('identity'),
    registerEvents('identity', IDENTITY_EVENTS),
    PersistenceModule.auditWriterFor('identity'),
    registerAuditActions('identity', IDENTITY_AUDIT_ACTIONS),
    registerPermissions('identity', IDENTITY_PERMISSIONS),
    { provide: PASSWORD_HASHER, useFactory: () => new Argon2idPasswordHasher() },
    { provide: COMMON_PASSWORD_LIST, useFactory: () => new CheckedInCommonPasswords() },
    {
      provide: IDENTITY_MARKET_POLICY,
      inject: [MarketRegistry],
      useFactory: (markets: MarketRegistry) => new MarketConfigIdentityPolicy(markets),
    },
    accountRepositoryProvider,
    ...sessionProviders,
    ...linkProviders,
    ...merchantProviders,
    ...roleProviders,
    ...secondFactorProviders,
    adminAccountReaderProvider,
    {
      provide: AUTHENTICATOR,
      inject: [UNIT_OF_WORK, SESSION_REPOSITORY, SESSION_TOKENS, CLOCK],
      useFactory: (
        unitOfWork: UnitOfWork,
        sessions: SessionRepository,
        tokens: SessionTokens,
        clock: Clock,
      ) => new SessionAuthenticator({ unitOfWork, sessions, tokens, clock }),
    },
    {
      provide: AUTHORISATION_CHECK,
      inject: [
        UNIT_OF_WORK,
        ACCOUNT_REPOSITORY,
        MERCHANT_MEMBERSHIP_REPOSITORY,
        MERCHANT_REPOSITORY,
        ROLE_GRANT_READER,
        EFFECTIVE_KEY_RESOLVER,
      ],
      useFactory: (
        unitOfWork: UnitOfWork,
        accounts: AccountRepository,
        memberships: MerchantMembershipRepository,
        merchants: MerchantRepository,
        grants: RoleGrantReader,
        effectiveKeys: EffectiveKeyResolver,
      ) =>
        new AccountAuthorisationCheck({
          unitOfWork,
          accounts,
          memberships,
          merchants,
          grants,
          effectiveKeys,
        }),
    },
    useCaseProvider(AssignAdminRole, {
      unitOfWork: true,
      accounts: true,
      roles: true,
      assignments: true,
      grants: true,
      effectiveKeys: true,
      permissions: true,
      outbox: true,
      audit: true,
      clock: true,
    }),
    useCaseProvider(ListPlatformRoles, {
      unitOfWork: true,
      accounts: true,
      roles: true,
      assignments: true,
      grants: true,
      effectiveKeys: true,
      permissions: true,
    }),
    useCaseProvider(ResetAdminSecondFactor, {
      unitOfWork: true,
      accounts: true,
      factors: true,
      sessions: true,
      challenges: true,
      outbox: true,
      audit: true,
      clock: true,
    }),
    useCaseProvider(RegenerateRecoveryCodes, {
      unitOfWork: true,
      accounts: true,
      factors: true,
      throttles: true,
      keys: true,
      secrets: true,
      outbox: true,
      clock: true,
      audit: true,
      policy: true,
    }),
    useCaseProvider(StartSecondFactorReplacement, {
      unitOfWork: true,
      accounts: true,
      factors: true,
      throttles: true,
      keys: true,
      secrets: true,
      outbox: true,
      clock: true,
      audit: true,
      policy: true,
    }),
    useCaseProvider(SendSecondFactorMail, {
      unitOfWork: true,
      accounts: true,
      composer: true,
      transport: true,
      policy: true,
    }),
    useCaseProvider(SendOtherSessionsSignedOutMail, {
      unitOfWork: true,
      accounts: true,
      composer: true,
      transport: true,
      policy: true,
    }),
    useCaseProvider(CompleteSecondFactorReplacement, {
      unitOfWork: true,
      accounts: true,
      factors: true,
      throttles: true,
      keys: true,
      secrets: true,
      outbox: true,
      clock: true,
      audit: true,
      policy: true,
      sessions: true,
      challenges: true,
      tokens: true,
    }),
    useCaseProvider(InviteAdmin, {
      unitOfWork: true,
      accounts: true,
      roles: true,
      grants: true,
      effectiveKeys: true,
      permissions: true,
      invitations: true,
      throttles: true,
      keys: true,
      outbox: true,
      audit: true,
      policy: true,
      clock: true,
      ids: true,
    }),
    useCaseProvider(ChangeDisplayName, {
      unitOfWork: true,
      accounts: true,
      outbox: true,
      clock: true,
    }),
    useCaseProvider(SignOut, { unitOfWork: true, sessions: true, clock: true }),
    useCaseProvider(ResendAdminInvitation, {
      unitOfWork: true,
      accounts: true,
      roles: true,
      grants: true,
      effectiveKeys: true,
      permissions: true,
      invitations: true,
      throttles: true,
      keys: true,
      outbox: true,
      audit: true,
      policy: true,
      clock: true,
    }),
    useCaseProvider(RequestPasswordReset, {
      unitOfWork: true,
      accounts: true,
      links: true,
      throttles: true,
      keys: true,
      outbox: true,
      policy: true,
      clock: true,
      ids: true,
    }),
    useCaseProvider(ListOwnSessions, { unitOfWork: true, sessions: true, clock: true }),
    useCaseProvider(EnableAdminAccount, {
      unitOfWork: true,
      accounts: true,
      roles: true,
      assignments: true,
      grants: true,
      effectiveKeys: true,
      sessions: true,
      challenges: true,
      outbox: true,
      audit: true,
      clock: true,
    }),
    useCaseProvider(SendPasswordChangedMail, {
      unitOfWork: true,
      accounts: true,
      composer: true,
      transport: true,
      policy: true,
    }),
    useCaseProvider(ContactEmailOf, {
      unitOfWork: true,
      accounts: true,
    }),
    useCaseProvider(IsActiveCourier, {
      unitOfWork: true,
      accounts: true,
    }),
    useCaseProvider(IssueFirstAdminInvitation, {
      unitOfWork: true,
      accounts: true,
      roles: true,
      invitations: true,
      outbox: true,
      audit: true,
      policy: true,
      clock: true,
      ids: true,
    }),
    useCaseProvider(CompleteAdminSignIn, {
      unitOfWork: true,
      accounts: true,
      challenges: true,
      factors: true,
      throttles: true,
      records: true,
      keys: true,
      secrets: true,
      challengeTokens: true,
      outbox: true,
      clock: true,
      ids: true,
      sessions: true,
      tokens: true,
      audit: true,
      policy: true,
    }),
    useCaseProvider(PurgeExpired, {
      unitOfWork: true,
      sessions: true,
      challenges: true,
      invitations: true,
      throttles: true,
      records: true,
      links: true,
      policy: true,
      clock: true,
    }),
    useCaseProvider(RevokeAdminInvitation, {
      unitOfWork: true,
      accounts: true,
      grants: true,
      effectiveKeys: true,
      invitations: true,
      outbox: true,
      audit: true,
      clock: true,
    }),
    useCaseProvider(SendInvitationMail, {
      unitOfWork: true,
      invitations: true,
      invitationTokens: true,
      targets: true,
      composer: true,
      transport: true,
      policy: true,
      clock: true,
    }),
    useCaseProvider(ChangePassword, {
      unitOfWork: true,
      accounts: true,
      challenges: true,
      factors: true,
      secrets: true,
      sessions: true,
      links: true,
      throttles: true,
      records: true,
      ids: true,
      keys: true,
      tokens: true,
      outbox: true,
      hasher: true,
      commonPasswords: true,
      policy: true,
      clock: true,
    }),
    useCaseProvider(AcceptAdminInvitation, {
      unitOfWork: true,
      accounts: true,
      invitations: true,
      roles: true,
      assignments: true,
      factors: true,
      throttles: true,
      keys: true,
      invitationTokens: true,
      enrolmentTags: true,
      secrets: true,
      hasher: true,
      commonPasswords: true,
      grants: true,
      effectiveKeys: true,
      permissions: true,
      outbox: true,
      audit: true,
      policy: true,
      clock: true,
      ids: true,
    }),
    useCaseProvider(SignOutOtherSessions, {
      unitOfWork: true,
      accounts: true,
      sessions: true,
      throttles: true,
      keys: true,
      outbox: true,
      policy: true,
      audit: true,
      clock: true,
    }),
    useCaseProvider(SignInAdmin, {
      unitOfWork: true,
      accounts: true,
      sessions: true,
      throttles: true,
      records: true,
      hasher: true,
      tokens: true,
      keys: true,
      policy: true,
      clock: true,
      ids: true,
      factors: true,
      challenges: true,
      links: true,
      outbox: true,
      challengeTokens: true,
    }),
    useCaseProvider(StartAdminInvitationAcceptance, {
      unitOfWork: true,
      invitations: true,
      throttles: true,
      keys: true,
      invitationTokens: true,
      secrets: true,
      enrolmentTags: true,
      policy: true,
      clock: true,
    }),
    useCaseProvider(ConfirmSecondFactorEnrolment, {
      unitOfWork: true,
      accounts: true,
      challenges: true,
      factors: true,
      throttles: true,
      records: true,
      keys: true,
      secrets: true,
      challengeTokens: true,
      outbox: true,
      clock: true,
      ids: true,
      sessions: true,
      audit: true,
      policy: true,
    }),
    useCaseProvider(ResetPassword, {
      unitOfWork: true,
      accounts: true,
      challenges: true,
      factors: true,
      links: true,
      sessions: true,
      throttles: true,
      records: true,
      ids: true,
      keys: true,
      linkTokens: true,
      outbox: true,
      hasher: true,
      commonPasswords: true,
      policy: true,
      clock: true,
    }),
    useCaseProvider(ResetOtherAdminSecondFactor, {
      unitOfWork: true,
      accounts: true,
      roles: true,
      assignments: true,
      grants: true,
      effectiveKeys: true,
      factors: true,
      sessions: true,
      challenges: true,
      outbox: true,
      audit: true,
      clock: true,
    }),
    useCaseProvider(DescribeActor, {
      unitOfWork: true,
      accounts: true,
      sessions: true,
      merchants: true,
      grants: true,
      effectiveKeys: true,
      factors: true,
      records: true,
    }),
    useCaseProvider(SeedRoles, {
      unitOfWork: true,
      roles: true,
      seed: true,
      permissions: true,
      clock: true,
      ids: true,
      audit: true,
    }),
    useCaseProvider(DisableAdminAccount, {
      unitOfWork: true,
      accounts: true,
      roles: true,
      assignments: true,
      grants: true,
      effectiveKeys: true,
      sessions: true,
      challenges: true,
      outbox: true,
      audit: true,
      clock: true,
    }),
    useCaseProvider(SendLinkMail, {
      unitOfWork: true,
      accounts: true,
      links: true,
      linkTokens: true,
      targets: true,
      composer: true,
      transport: true,
      policy: true,
      clock: true,
    }),
    useCaseProvider(ListAdminTeam, {
      unitOfWork: true,
      accounts: true,
      adminAccounts: true,
      invitations: true,
      roles: true,
      assignments: true,
      grants: true,
      effectiveKeys: true,
      permissions: true,
      factors: true,
      policy: true,
      clock: true,
    }),
    useCaseProvider(StartSecondFactorEnrolment, {
      unitOfWork: true,
      accounts: true,
      links: true,
      factors: true,
      challenges: true,
      throttles: true,
      records: true,
      keys: true,
      linkTokens: true,
      challengeTokens: true,
      secrets: true,
      hasher: true,
      policy: true,
      clock: true,
      ids: true,
    }),
    useCaseProvider(ChangePanelPreferences, {
      unitOfWork: true,
      accounts: true,
    }),
    useCaseProvider(SignInCourier, {
      unitOfWork: true,
      accounts: true,
      sessions: true,
      throttles: true,
      records: true,
      hasher: true,
      tokens: true,
      keys: true,
      policy: true,
      clock: true,
      ids: true,
    }),
    useCaseProvider(DisableCourierAccount, {
      unitOfWork: true,
      accounts: true,
      roles: true,
      assignments: true,
      grants: true,
      effectiveKeys: true,
      sessions: true,
      challenges: true,
      outbox: true,
      audit: true,
      clock: true,
    }),
    useCaseProvider(EnableCourierAccount, {
      unitOfWork: true,
      accounts: true,
      roles: true,
      assignments: true,
      grants: true,
      effectiveKeys: true,
      sessions: true,
      challenges: true,
      outbox: true,
      audit: true,
      clock: true,
    }),
    useCaseProvider(InviteCourier, {
      unitOfWork: true,
      accounts: true,
      roles: true,
      grants: true,
      effectiveKeys: true,
      invitations: true,
      throttles: true,
      keys: true,
      outbox: true,
      audit: true,
      policy: true,
      clock: true,
      ids: true,
    }),
    useCaseProvider(AcceptCourierInvitation, {
      unitOfWork: true,
      accounts: true,
      invitations: true,
      roles: true,
      assignments: true,
      grants: true,
      effectiveKeys: true,
      throttles: true,
      keys: true,
      invitationTokens: true,
      hasher: true,
      commonPasswords: true,
      outbox: true,
      audit: true,
      policy: true,
      clock: true,
      ids: true,
    }),
    useCaseProvider(CreateMerchant, {
      ...MERCHANT_ADMIN_PORTS,
      roles: true,
      assignments: true,
      hasher: true,
    }),
    useCaseProvider(ListMerchants, MERCHANT_ADMIN_PORTS),
    useCaseProvider(SuspendMerchant, MERCHANT_ADMIN_PORTS),
    useCaseProvider(ReinstateMerchant, MERCHANT_ADMIN_PORTS),
    useCaseProvider(IssueMerchantApiKey, MERCHANT_ADMIN_PORTS),
    useCaseProvider(RevokeMerchantApiKey, MERCHANT_ADMIN_PORTS),
    useCaseProvider(ListMerchantApiKeys, MERCHANT_ADMIN_PORTS),
    roleEditorProvider(CreatePlatformRole),
    roleEditorProvider(EditPlatformRole),
    roleEditorProvider(DeletePlatformRole),
    {
      provide: IDENTITY_FACADE,
      inject: [DescribeActor, ContactEmailOf, IsActiveCourier],
      useFactory: (
        describeActor: DescribeActor,
        contactEmailOf: ContactEmailOf,
        isActiveCourier: IsActiveCourier,
      ) => new IdentityFacadeImplementation({ describeActor, contactEmailOf, isActiveCourier }),
    },
    registerJobsFrom(
      'identity',
      [PurgeExpired, SeedRoles],
      (purge: PurgeExpired, seedRoles: SeedRoles) => [
        purgeExpiredJob(purge),
        seedRolesJob(seedRoles),
      ],
    ),
    registerSubscriptionsFrom(
      'identity',
      [
        SendLinkMail,
        SendPasswordChangedMail,
        SendInvitationMail,
        SendSecondFactorMail,
        SendOtherSessionsSignedOutMail,
      ],
      (
        sendLinkMail: SendLinkMail,
        sendPasswordChangedMail: SendPasswordChangedMail,
        sendInvitationMail: SendInvitationMail,
        sendSecondFactorMail: SendSecondFactorMail,
        sendOtherSessionsSignedOutMail: SendOtherSessionsSignedOutMail,
      ) =>
        identityMailSubscriptions(
          sendLinkMail,
          sendPasswordChangedMail,
          sendInvitationMail,
          sendSecondFactorMail,
          sendOtherSessionsSignedOutMail,
        ),
    ),
  ],
  exports: [AUTHENTICATOR, AUTHORISATION_CHECK, IDENTITY_FACADE],
})
export class IdentityModule {}
