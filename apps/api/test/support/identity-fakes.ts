import {
  ADMIN_ACCOUNT_READER,
  type AdminAccountReader,
} from '../../src/modules/identity/application/ports/admin-account-reader';
import { createHmac } from 'node:crypto';
import type { TestingModuleBuilder } from '@nestjs/testing';
import { err, ok, Temporal } from '@mondapac-drive/shared-kernel';
import type {
  AuditEntry,
  CallContext,
  Id,
  MarketContext,
  PendingEvent,
  Population,
  Result,
} from '@mondapac-drive/shared-kernel';
import {
  ACCOUNT_REPOSITORY,
  type AccountRepository,
} from '../../src/modules/identity/application/ports/account.repository';
import {
  PASSWORD_HASHER,
  type PasswordHasher,
  type PasswordHasherBusy,
  type PasswordVerification,
} from '../../src/modules/identity/application/ports/password-hasher';
import type { RoleGrant } from '../../src/modules/identity/application/access/effective-keys';
import {
  ROLE_GRANT_READER,
  type RoleGrantReader,
} from '../../src/modules/identity/application/ports/role-grant-reader';
import {
  SESSION_REPOSITORY,
  type SessionForAuthentication,
  type SessionRepository,
} from '../../src/modules/identity/application/ports/session.repository';
import {
  SIGN_IN_RECORD_REPOSITORY,
  type SignInRecord,
  type SignInRecordRepository,
} from '../../src/modules/identity/application/ports/sign-in-record.repository';
import {
  THROTTLE_REPOSITORY,
  type ThrottleCounter,
  type ThrottleRepository,
} from '../../src/modules/identity/application/ports/throttle.repository';
import {
  ONE_TIME_LINK_REPOSITORY,
  type OneTimeLinkRepository,
} from '../../src/modules/identity/application/ports/one-time-link.repository';
import {
  ROLE_ASSIGNMENT_REPOSITORY,
  ROLE_REPOSITORY,
  type RoleAssignmentRepository,
  type RoleRepository,
} from '../../src/modules/identity/application/ports/role.repository';
import {
  MERCHANT_MEMBERSHIP_REPOSITORY,
  MERCHANT_REPOSITORY,
  type MerchantMembershipRepository,
  type MerchantRepository,
} from '../../src/modules/identity/application/ports/merchant.repository';
import {
  Merchant,
  type MerchantMembership,
  type MerchantState,
} from '../../src/modules/identity/domain/merchant';
import {
  INVITATION_REPOSITORY,
  InvitationAlreadyPendingError,
  type InvitationRepository,
} from '../../src/modules/identity/application/ports/invitation.repository';
import {
  SECOND_FACTOR_REPOSITORY,
  type SecondFactorRepository,
} from '../../src/modules/identity/application/ports/second-factor.repository';
import {
  SECOND_FACTOR_SECRETS,
  type SecondFactorSecrets,
} from '../../src/modules/identity/application/ports/second-factor-secrets';
import { SubjectKeySecondFactorSecrets } from '../../src/modules/identity/infrastructure/second-factor/subject-key-second-factor-secrets';
import {
  SubjectKeyIntegrityError,
  SubjectKeyMissingError,
  type SubjectKeyService,
} from '../../src/platform/subject-keys/subject-key-service';
import {
  SIGN_IN_CHALLENGE_REPOSITORY,
  type SignInChallengeRepository,
} from '../../src/modules/identity/application/ports/sign-in-challenge.repository';
import { Invitation, type InvitationState } from '../../src/modules/identity/domain/invitation';
import {
  SecondFactor,
  type SecondFactorState,
} from '../../src/modules/identity/domain/second-factor';
import type { SignInChallenge } from '../../src/modules/identity/domain/sign-in-challenge';
import { Account, type AccountState } from '../../src/modules/identity/domain/account';
import {
  Role,
  RoleAssignment,
  type RoleAssignmentState,
  type RoleState,
} from '../../src/modules/identity/domain/role';
import {
  OneTimeLink,
  type OneTimeLinkState,
} from '../../src/modules/identity/domain/one-time-link';
import type { Session } from '../../src/modules/identity/domain/session';
import {
  windowRestartBefore,
  type ThrottleReservation,
} from '../../src/modules/identity/domain/throttle';
import { AUDIT_WRITER, type AuditWriter } from '../../src/platform/audit/audit-writer';
import { OUTBOX_WRITER, type OutboxWriter } from '../../src/platform/events/outbox-writer';
import {
  MAIL_TRANSPORT,
  type MailMessage,
  type MailTransport,
} from '../../src/platform/mail/mail-transport';
import { StaleAggregateError } from '../../src/platform/unit-of-work/errors';
import { UNIT_OF_WORK, type UnitOfWork } from '../../src/platform/unit-of-work/unit-of-work';
import { fakeRunOnce } from './fake-run-once';

// In-memory fakes of identity's database ports, for the HTTP suites of `pnpm test` (no
// database). Units are not isolated: `run` calls `work` once. The fakes keep the rules the
// suites depend on (unique keys, the throttle windows of data design 3.5); the PostgreSQL
// behaviour itself is covered by test/db/.

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');

/** A fake PHC string: `fake$<password>`; verify compares the password. */
export const fakeHashOf = (password: string): string => `$argon2id$v=19$fake$${password}`;

export class IdentityFakes {
  readonly accounts = new Map<string, AccountState>();
  readonly sessions = new Map<string, { session: Session; tokenHash: string }>();
  readonly throttles = new Map<string, ThrottleReservation & { accountKey: string | null }>();
  readonly records: (SignInRecord & { marketId: string })[] = [];
  readonly events: PendingEvent[] = [];
  /** Audit entries recorded through identity's writer, with the actor kind and Market. */
  readonly audits: (AuditEntry & { actor: string; marketId: string })[] = [];
  readonly links = new Map<string, OneTimeLinkState>();
  readonly merchants = new Map<string, MerchantState>();
  readonly memberships = new Map<string, MerchantMembership>();
  readonly roles = new Map<string, RoleState>();
  readonly assignments = new Map<string, RoleAssignmentState>();
  /** Second factors by account id (slice 7). */
  readonly factors = new Map<string, SecondFactorState>();
  /** Sign-in challenges by id, with the hex of their token hash (slice 7). */
  readonly challenges = new Map<string, { challenge: SignInChallenge; tokenHash: string }>();
  readonly invitations = new Map<string, InvitationState>();
  /** Subject keys created and destroyed, by subject id (accounts). */
  readonly subjectKeys = new Map<string, 'live' | 'destroyed'>();
  /** Every account whose credential lock was taken, in order (N1). */
  readonly credentialLocks: string[] = [];
  /** Mails the fake transport accepted, in order. */
  readonly mails: MailMessage[] = [];
  /** Makes the fake transport refuse every send. */
  mailDown = false;
  hashed = 0;
  verified = 0;
  busy = false;
  /** Makes every correct verification ask for a re-hash (older parameters). */
  needsRehash = false;
  /** Makes the reservation unit fail, as an unreachable counter table would. */
  throttlesDown = false;
  reset(): void {
    this.accounts.clear();
    this.sessions.clear();
    this.throttles.clear();
    this.records.length = 0;
    this.events.length = 0;
    this.audits.length = 0;
    this.links.clear();
    this.merchants.clear();
    this.memberships.clear();
    this.roles.clear();
    this.assignments.clear();
    this.subjectKeys.clear();
    this.factors.clear();
    this.challenges.clear();
    this.invitations.clear();
    this.credentialLocks.length = 0;
    this.mails.length = 0;
    this.mailDown = false;
    this.inbox.clear();
    this.hashed = 0;
    this.verified = 0;
    this.busy = false;
    this.needsRehash = false;
    this.throttlesDown = false;
  }

  /** Stores an account directly, as a test fixture. */
  seedAccount(state: AccountState): void {
    this.accounts.set(state.id, state);
  }

  /** Stores a merchant directly, as a test fixture. */
  seedMerchant(state: MerchantState): void {
    this.merchants.set(state.id, state);
  }

  /** Stores a membership directly, as a test fixture. */
  seedMembership(state: MerchantMembership): void {
    this.memberships.set(state.id, state);
  }

  /** Stores a role directly, as a test fixture. */
  seedRole(state: RoleState): void {
    this.roles.set(state.id, state);
  }

  /** Stores an assignment directly, as a test fixture (admin fixture accounts: tests only). */
  seedAssignment(state: RoleAssignmentState): void {
    this.assignments.set(state.id, state);
  }

  /** The inbox of identity's handlers: `(Market, eventId, subscriber)` keys. */
  readonly inbox = new Set<string>();

  readonly unitOfWork: UnitOfWork = {
    run: <T, E>(_market: MarketContext, work: () => Promise<Result<T, E>>) => work(),
    runOnce: fakeRunOnce(this.inbox),
  };

  readonly accountRepository: AccountRepository = {
    findByEmail: (market: MarketContext, population: Population, email: string) => {
      const state = [...this.accounts.values()].find(
        (a) =>
          a.marketId === market.marketId &&
          a.population === population &&
          a.email.normalized === email,
      );
      return Promise.resolve(state === undefined ? null : Account.restore(state));
    },
    findById: (market: MarketContext, id: Id<'Account'>) => {
      const state = this.accounts.get(id);
      return Promise.resolve(
        state === undefined || state.marketId !== market.marketId ? null : Account.restore(state),
      );
    },
    existsInPopulation: (market: MarketContext, population: Population) =>
      Promise.resolve(
        [...this.accounts.values()].some(
          (a) => a.marketId === market.marketId && a.population === population,
        ),
      ),
    lockCredential: (market: MarketContext, id: Id<'Account'>) => {
      const state = this.accounts.get(id);
      this.credentialLocks.push(id);
      return Promise.resolve(state !== undefined && state.marketId === market.marketId);
    },
    add: (_market: MarketContext, account: Account) => {
      this.subjectKeys.set(account.state.id, 'live');
      this.accounts.set(account.state.id, account.state);
      return Promise.resolve(ok(undefined));
    },
    save: (_market: MarketContext, account: Account) => {
      // As the repository: the stored version must be the one read (StaleAggregateError).
      if (account.state.version === account.persistedVersion) return Promise.resolve();
      const stored = this.accounts.get(account.state.id);
      if (stored === undefined || stored.version !== account.persistedVersion) {
        return Promise.reject(new StaleAggregateError('account', account.state.id));
      }
      this.accounts.set(account.state.id, account.state);
      return Promise.resolve();
    },
  };

  /** The admin team list's account read (slice 8c), over the fake accounts. */
  readonly adminAccountReader: AdminAccountReader = {
    adminAccounts: (market, after, limit) =>
      Promise.resolve(
        [...this.accounts.values()]
          .filter(
            (a) =>
              a.marketId === market.marketId &&
              a.population === 'admin' &&
              (after === null || a.id > after),
          )
          .sort((a, b) => (a.id < b.id ? -1 : 1))
          .slice(0, limit)
          .map((a) => ({
            accountId: a.id,
            email: a.email.typed,
            displayName: a.displayName,
            status: a.status,
          })),
      ),
  };

  readonly merchantRepository: MerchantRepository = {
    findById: (market, id) => {
      const state = this.merchants.get(id);
      return Promise.resolve(
        state === undefined || state.marketId !== market.marketId ? null : Merchant.restore(state),
      );
    },
    list: (market) =>
      Promise.resolve(
        [...this.merchants.values()]
          .filter((m) => m.marketId === market.marketId)
          .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.id < b.id ? -1 : 1))
          .map((state) => Merchant.restore(state)),
      ),
    add: (_market, merchant) => {
      this.merchants.set(merchant.state.id, merchant.state);
      return Promise.resolve();
    },
    save: (_market, merchant) => {
      if (merchant.state.version === merchant.persistedVersion) return Promise.resolve();
      const stored = this.merchants.get(merchant.state.id);
      if (stored === undefined || stored.version !== merchant.persistedVersion) {
        return Promise.reject(new StaleAggregateError('merchant', merchant.state.id));
      }
      this.merchants.set(merchant.state.id, merchant.state);
      return Promise.resolve();
    },
  };

  readonly membershipRepository: MerchantMembershipRepository = {
    findActiveByAccount: (market, accountId) =>
      Promise.resolve(
        [...this.memberships.values()].find(
          (m) =>
            m.marketId === market.marketId && m.accountId === accountId && m.state === 'active',
        ) ?? null,
      ),
    activeMembersOf: (market, merchantId) =>
      Promise.resolve(
        [...this.memberships.values()]
          .filter(
            (m) =>
              m.marketId === market.marketId && m.merchantId === merchantId && m.state === 'active',
          )
          .map((m) => m.accountId)
          .sort(),
      ),
    add: (_market, membership) => {
      const active = [...this.memberships.values()].some(
        (m) =>
          m.marketId === membership.marketId &&
          m.accountId === membership.accountId &&
          m.state === 'active',
      );
      if (active && membership.state === 'active') {
        return Promise.reject(new Error('merchant_memberships_market_id_account_id_active_key'));
      }
      this.memberships.set(membership.id, membership);
      return Promise.resolve();
    },
  };

  readonly roleRepository: RoleRepository = {
    findSystemRole: (market, scope) => {
      const state = [...this.roles.values()].find(
        (r) => r.marketId === market.marketId && r.scope === scope && r.kind === 'system',
      );
      return Promise.resolve(state === undefined ? null : Role.restore(state));
    },
    findById: (market, id) => {
      const state = this.roles.get(id);
      return Promise.resolve(
        state === undefined || state.marketId !== market.marketId ? null : Role.restore(state),
      );
    },
    platformRoles: (market) =>
      Promise.resolve(
        [...this.roles.values()]
          .filter((r) => r.marketId === market.marketId && r.scope === 'platform')
          .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
          .map((state) => Role.restore(state)),
      ),
    countCustom: (market) =>
      Promise.resolve(
        [...this.roles.values()].filter(
          (r) => r.marketId === market.marketId && r.kind === 'custom',
        ).length,
      ),
    nameTaken: (market, nameNormalized, exceptRoleId) =>
      Promise.resolve(
        [...this.roles.values()].some(
          (r) =>
            r.marketId === market.marketId &&
            r.kind === 'custom' &&
            r.id !== exceptRoleId &&
            Role.restore(r).nameNormalized === nameNormalized,
        ),
      ),
    addCustom: (_market, role) => {
      this.roles.set(role.state.id, role.state);
      return Promise.resolve();
    },
    saveCustom: (_market, edit) => {
      const state = edit.role.state;
      const stored = this.roles.get(state.id);
      if (stored === undefined || stored.version !== edit.role.persistedVersion) {
        return Promise.reject(new StaleAggregateError('role', state.id));
      }
      this.roles.set(state.id, state);
      return Promise.resolve();
    },
    deleteCustom: (_market, role) => {
      const stored = this.roles.get(role.state.id);
      if (stored === undefined || stored.version !== role.persistedVersion) {
        return Promise.reject(new StaleAggregateError('role', role.state.id));
      }
      this.roles.delete(role.state.id);
      return Promise.resolve();
    },
    findBySeedCode: (market, scope, seedCode) => {
      const state = [...this.roles.values()].find(
        (r) => r.marketId === market.marketId && r.scope === scope && r.seedCode === seedCode,
      );
      return Promise.resolve(state === undefined ? null : Role.restore(state));
    },
    addSeeded: (_market, role) => {
      const state = role.state;
      const exists = [...this.roles.values()].some(
        (r) =>
          r.marketId === state.marketId &&
          r.scope === state.scope &&
          (r.seedCode === state.seedCode || (r.kind === 'system' && state.kind === 'system')),
      );
      if (exists) return Promise.resolve(false);
      this.roles.set(state.id, state);
      return Promise.resolve(true);
    },
    applySeed: (_market, upgrade) => {
      const state = upgrade.role.state;
      const stored = this.roles.get(state.id);
      if (stored === undefined || stored.version !== upgrade.role.persistedVersion) {
        return Promise.reject(new StaleAggregateError('role', state.id));
      }
      this.roles.set(state.id, state);
      return Promise.resolve();
    },
  };

  /**
   * The grant read over the fake roles and assignments, as `PrismaRoleGrantReader` answers it:
   * each account's assigned role with its scope, kind and stored keys.
   */
  readonly grantReader: RoleGrantReader = {
    grantsOf: (market, accountIds) => {
      const grants = new Map<Id<'Account'>, RoleGrant>();
      for (const accountId of accountIds) {
        const assignment = [...this.assignments.values()].find(
          (a) => a.marketId === market.marketId && a.accountId === accountId,
        );
        const role = assignment === undefined ? undefined : this.roles.get(assignment.roleId);
        if (role === undefined || role.marketId !== market.marketId) continue;
        grants.set(accountId, {
          roleId: role.id,
          kind: role.kind,
          scope: role.scope,
          storedKeys: role.kind === 'system' ? [] : role.permissionKeys,
        });
      }
      return Promise.resolve(grants);
    },
  };

  readonly assignmentRepository: RoleAssignmentRepository = {
    heldRoles: (market, roleIds) =>
      Promise.resolve(
        new Set(
          [...this.assignments.values()]
            .filter((a) => a.marketId === market.marketId && roleIds.includes(a.roleId))
            .map((a) => a.roleId),
        ),
      ),
    findByAccount: (market, accountId) => {
      const state = [...this.assignments.values()].find(
        (a) => a.marketId === market.marketId && a.accountId === accountId,
      );
      return Promise.resolve(state === undefined ? null : RoleAssignment.restore(state));
    },
    add: (_market, assignment) => {
      const state = assignment.state;
      if (
        [...this.assignments.values()].some(
          (a) => a.marketId === state.marketId && a.accountId === state.accountId,
        )
      ) {
        return Promise.reject(new Error('role_assignments_market_id_account_id_key'));
      }
      this.assignments.set(state.id, state);
      return Promise.resolve();
    },
    hasActiveHolder: (market, roleId) =>
      Promise.resolve(
        [...this.assignments.values()].some((a) => {
          const account = this.accounts.get(a.accountId);
          return (
            a.marketId === market.marketId &&
            a.roleId === roleId &&
            account?.status === 'active' &&
            account.emailVerifiedAt !== null
          );
        }),
      ),
    activeHoldersOf: (market, roleId) =>
      Promise.resolve(
        [...this.assignments.values()]
          .filter((a) => {
            const account = this.accounts.get(a.accountId);
            return (
              a.marketId === market.marketId &&
              a.roleId === roleId &&
              account?.status === 'active' &&
              account.emailVerifiedAt !== null
            );
          })
          .map((a) => a.accountId),
      ),
    save: (_market, assignment) => {
      const state = assignment.state;
      if (state.version === assignment.persistedVersion) return Promise.resolve();
      if (this.assignments.get(state.id)?.version !== assignment.persistedVersion) {
        return Promise.reject(new StaleAggregateError('role-assignment', state.id));
      }
      this.assignments.set(state.id, state);
      return Promise.resolve();
    },
    remove: (_market, assignment) => {
      const stored = this.assignments.get(assignment.state.id);
      if (stored === undefined || stored.version !== assignment.persistedVersion) {
        return Promise.reject(new StaleAggregateError('role-assignment', assignment.state.id));
      }
      this.assignments.delete(assignment.state.id);
      return Promise.resolve();
    },
  };

  readonly linkRepository: OneTimeLinkRepository = {
    findById: (market, id) => {
      const state = this.links.get(id);
      return Promise.resolve(
        state === undefined || state.marketId !== market.marketId
          ? null
          : OneTimeLink.restore(state),
      );
    },
    findFor: (market, accountId, purpose) => {
      const state = [...this.links.values()].find(
        (l) => l.marketId === market.marketId && l.accountId === accountId && l.purpose === purpose,
      );
      return Promise.resolve(state === undefined ? null : OneTimeLink.restore(state));
    },
    findByTokenHash: (market, tokenHash) => {
      const state = [...this.links.values()].find(
        (l) =>
          l.marketId === market.marketId &&
          l.tokenHash !== null &&
          hex(l.tokenHash) === hex(tokenHash),
      );
      return Promise.resolve(state === undefined ? null : OneTimeLink.restore(state));
    },
    add: (_market, link) => {
      this.links.set(link.state.id, link.state);
      return Promise.resolve();
    },
    save: (_market, link) => {
      const stored = this.links.get(link.state.id);
      if (stored === undefined || stored.version !== link.persistedVersion) {
        return Promise.reject(new StaleAggregateError('one-time-link', link.state.id));
      }
      this.links.set(link.state.id, link.state);
      return Promise.resolve();
    },
    consume: (market, id, expectedVersion, now) => {
      const stored = this.links.get(id);
      if (
        stored === undefined ||
        stored.marketId !== market.marketId ||
        stored.version !== expectedVersion ||
        stored.consumedAt !== null ||
        stored.expiresAt === null ||
        Temporal.Instant.compare(stored.expiresAt, now) <= 0
      ) {
        return Promise.resolve(false);
      }
      this.links.set(id, { ...stored, consumedAt: now, version: stored.version + 1 });
      return Promise.resolve(true);
    },
    cancelUnused: (market, accountId, purpose) => {
      const state = [...this.links.values()].find(
        (l) =>
          l.marketId === market.marketId &&
          l.accountId === accountId &&
          l.purpose === purpose &&
          l.consumedAt === null,
      );
      if (state === undefined) return Promise.resolve(false);
      this.links.set(state.id, {
        ...state,
        tokenHash: null,
        issuedAt: null,
        expiresAt: null,
        version: state.version + 1,
      });
      return Promise.resolve(true);
    },
    purgeSpent: () => Promise.resolve(0),
  };

  readonly mailTransport: MailTransport = {
    send: (message) => {
      if (this.mailDown) return Promise.reject(new Error('mail transport down'));
      this.mails.push(message);
      return Promise.resolve();
    },
  };

  readonly sessionRepository: SessionRepository = {
    add: (_market: MarketContext, session: Session, tokenHash: Uint8Array) => {
      this.sessions.set(session.id, { session, tokenHash: hex(tokenHash) });
      return Promise.resolve();
    },
    findForAuthentication: (market: MarketContext, tokenHash: Uint8Array) => {
      const found = [...this.sessions.values()].find(
        (s) => s.session.marketId === market.marketId && s.tokenHash === hex(tokenHash),
      );
      if (found === undefined) return Promise.resolve(null);
      const account = this.accounts.get(found.session.accountId)!;
      const membership = [...this.memberships.values()].find(
        (m) =>
          m.marketId === market.marketId &&
          m.accountId === found.session.accountId &&
          m.state === 'active',
      );
      const merchantId = found.session.merchantId;
      const merchant = merchantId === null ? undefined : this.merchants.get(merchantId);
      const answer: SessionForAuthentication = {
        session: found.session,
        accountStatus: account.status,
        activeMembershipMerchantId: membership?.merchantId ?? null,
        merchantState:
          merchant === undefined || merchant.marketId !== market.marketId ? null : merchant.state,
      };
      return Promise.resolve(answer);
    },
    findById: (market: MarketContext, id: Id<'Session'>) => {
      const found = this.sessions.get(id);
      return Promise.resolve(
        found === undefined || found.session.marketId !== market.marketId ? null : found.session,
      );
    },
    listUnrevokedOf: (market, accountId, now, limit) =>
      Promise.resolve(
        [...this.sessions.values()]
          .map((found) => found.session)
          .filter(
            (s) =>
              s.marketId === market.marketId &&
              s.accountId === accountId &&
              s.revokedAt === null &&
              Temporal.Instant.compare(s.absoluteExpiresAt, now) > 0,
          )
          .sort((a, b) => Temporal.Instant.compare(b.lastSeenAt, a.lastSeenAt))
          .slice(0, limit),
      ),
    touch: (_market, id, now, lastSeenBefore) => {
      const found = this.sessions.get(id);
      if (
        found !== undefined &&
        found.session.revokedAt === null &&
        Temporal.Instant.compare(found.session.lastSeenAt, lastSeenBefore) <= 0
      ) {
        found.session = { ...found.session, lastSeenAt: now };
      }
      return Promise.resolve();
    },
    revoke: (market, id, accountId, reason, now) => {
      const found = this.sessions.get(id);
      if (
        found === undefined ||
        found.session.marketId !== market.marketId ||
        found.session.accountId !== accountId ||
        found.session.revokedAt !== null
      ) {
        return Promise.resolve(false);
      }
      found.session = { ...found.session, revokedAt: now, revokedReason: reason };
      return Promise.resolve(true);
    },
    revokeAllOf: (market, accountId, reason, now, exceptId) => {
      let count = 0;
      for (const found of this.sessions.values()) {
        const s = found.session;
        if (
          s.marketId === market.marketId &&
          s.accountId === accountId &&
          s.revokedAt === null &&
          s.id !== exceptId
        ) {
          found.session = { ...s, revokedAt: now, revokedReason: reason };
          count += 1;
        }
      }
      return Promise.resolve(count);
    },
    listApiKeysOf: (market, merchantId, now) =>
      Promise.resolve(
        [...this.sessions.values()]
          .map((found) => found.session)
          .filter(
            (s) =>
              s.marketId === market.marketId &&
              s.merchantId === merchantId &&
              s.transport === 'api-key' &&
              s.revokedAt === null &&
              Temporal.Instant.compare(s.absoluteExpiresAt, now) > 0,
          )
          .sort(
            (a, b) => Temporal.Instant.compare(b.createdAt, a.createdAt) || (a.id < b.id ? 1 : -1),
          ),
      ),
    revokeAllOfMerchant: (market, merchantId, reason, now) => {
      let count = 0;
      for (const found of this.sessions.values()) {
        const s = found.session;
        if (s.marketId === market.marketId && s.merchantId === merchantId && s.revokedAt === null) {
          found.session = { ...s, revokedAt: now, revokedReason: reason };
          count += 1;
        }
      }
      return Promise.resolve(count);
    },
    rotate: (market, id, accountId, tokenHash) => {
      const found = this.sessions.get(id);
      if (
        found === undefined ||
        found.session.marketId !== market.marketId ||
        found.session.accountId !== accountId ||
        found.session.revokedAt !== null
      ) {
        return Promise.resolve(false);
      }
      found.tokenHash = hex(tokenHash);
      return Promise.resolve(true);
    },
    purgeExpired: () => Promise.resolve(0),
  };

  readonly throttleRepository: ThrottleRepository = {
    reserve: (market: MarketContext, counters: readonly ThrottleCounter[], now) => {
      if (this.throttlesDown) return Promise.reject(new Error('counter table unreachable'));
      return Promise.resolve(
        counters.map((counter) => {
          const key = `${market.marketId}|${counter.kind}|${hex(counter.keyHash)}`;
          const existing = this.throttles.get(key);
          const created: ThrottleReservation & { accountKey: string | null } = {
            kind: counter.kind,
            keyHash: counter.keyHash,
            accountKey: counter.accountKey === null ? null : hex(counter.accountKey),
            attempts: 0,
            windowStartedAt: now,
            blockedUntil: null,
          };
          let row = existing ?? created;
          if (
            existing !== undefined &&
            Temporal.Instant.compare(row.windowStartedAt, windowRestartBefore(counter.rule, now)) <=
              0
          ) {
            row = { ...row, attempts: 0, windowStartedAt: now };
          }
          row = { ...row, attempts: row.attempts + 1 };
          this.throttles.set(key, row);
          const reservation: ThrottleReservation = {
            kind: row.kind,
            keyHash: row.keyHash,
            attempts: row.attempts,
            windowStartedAt: row.windowStartedAt,
            blockedUntil: row.blockedUntil,
          };
          return reservation;
        }),
      );
    },
    release: (market, reservations) => {
      for (const r of reservations) {
        const key = `${market.marketId}|${r.kind}|${hex(r.keyHash)}`;
        const row = this.throttles.get(key);
        if (
          row !== undefined &&
          row.attempts > 0 &&
          row.windowStartedAt.equals(r.windowStartedAt)
        ) {
          this.throttles.set(key, { ...row, attempts: row.attempts - 1 });
        }
      }
      return Promise.resolve();
    },
    block: (market, blocks) => {
      for (const { reservation: r, until } of blocks) {
        const key = `${market.marketId}|${r.kind}|${hex(r.keyHash)}`;
        const row = this.throttles.get(key);
        if (row !== undefined && row.windowStartedAt.equals(r.windowStartedAt)) {
          this.throttles.set(key, { ...row, blockedUntil: until });
        }
      }
      return Promise.resolve();
    },
    clearAccount: (market, accountKey) => {
      let count = 0;
      for (const [key, row] of this.throttles) {
        if (
          key.startsWith(`${market.marketId}|`) &&
          row.accountKey === hex(accountKey) &&
          (row.kind === 'sign-in.account' || row.kind === 'sign-in.account-origin')
        ) {
          this.throttles.delete(key);
          count += 1;
        }
      }
      return Promise.resolve(count);
    },
    purge: () => Promise.resolve(0),
  };

  readonly recordRepository: SignInRecordRepository = {
    add: (market, record) => {
      this.records.push({ ...record, marketId: market.marketId });
      return Promise.resolve();
    },
    latestSuccessBefore: (market, accountId, exceptSession) => {
      const latest = this.records
        .filter(
          (record) =>
            record.marketId === market.marketId &&
            record.accountId === accountId &&
            record.outcome === 'signed-in' &&
            record.sessionId !== exceptSession,
        )
        .reduce<Temporal.Instant | null>(
          (best, record) =>
            best === null || Temporal.Instant.compare(record.occurredAt, best) > 0
              ? record.occurredAt
              : best,
          null,
        );
      return Promise.resolve(latest);
    },
    oldest: () => Promise.resolve(null),
    deleteBetween: () => Promise.resolve(0),
  };

  readonly factorRepository: SecondFactorRepository = {
    findByAccount: (market, accountId) => {
      const state = this.factors.get(accountId);
      return Promise.resolve(
        state === undefined || state.marketId !== market.marketId
          ? null
          : SecondFactor.restore(state),
      );
    },
    add: (_market, factor) => {
      const state = factor.state;
      if (this.factors.has(state.accountId)) {
        return Promise.reject(new StaleAggregateError('second-factor', state.id));
      }
      this.factors.set(state.accountId, state);
      return Promise.resolve();
    },
    save: (_market, factor) => {
      const state = factor.state;
      if (state.version === factor.persistedVersion) return Promise.resolve();
      const stored = this.factors.get(state.accountId);
      if (stored?.id !== state.id || stored.version !== factor.persistedVersion) {
        return Promise.reject(new StaleAggregateError('second-factor', state.id));
      }
      this.factors.set(state.accountId, state);
      return Promise.resolve();
    },
    acceptStep: (market, id, step) => {
      const stored = [...this.factors.values()].find(
        (state) => state.id === id && state.marketId === market.marketId,
      );
      if (
        stored?.state !== 'active' ||
        (stored.lastAcceptedStep !== null && stored.lastAcceptedStep >= step)
      ) {
        return Promise.resolve(false);
      }
      this.factors.set(stored.accountId, {
        ...stored,
        lastAcceptedStep: step,
        version: stored.version + 1,
      });
      return Promise.resolve(true);
    },
    useRecoveryCode: (market, id, codeHash, now) => {
      const stored = [...this.factors.values()].find(
        (state) => state.id === id && state.marketId === market.marketId,
      );
      const wanted = hex(codeHash);
      const code = stored?.recoveryCodes.find(
        (candidate) => candidate.usedAt === null && hex(candidate.codeHash) === wanted,
      );
      if (stored?.state !== 'active' || code === undefined) return Promise.resolve(false);
      this.factors.set(stored.accountId, {
        ...stored,
        recoveryCodes: stored.recoveryCodes.map((candidate) =>
          candidate.position === code.position ? { ...candidate, usedAt: now } : candidate,
        ),
        version: stored.version + 1,
      });
      return Promise.resolve(true);
    },
    removeOf: (market, accountId) => {
      const stored = this.factors.get(accountId);
      if (stored === undefined || stored.marketId !== market.marketId) {
        return Promise.resolve(false);
      }
      this.factors.delete(accountId);
      return Promise.resolve(true);
    },
    presentAmong: (market, accountIds) =>
      Promise.resolve(
        new Set(
          accountIds.filter(
            (accountId) => this.factors.get(accountId)?.marketId === market.marketId,
          ),
        ),
      ),
    activeAmong: (market, accountIds) =>
      Promise.resolve(
        new Set(
          accountIds.filter((accountId) => {
            const stored = this.factors.get(accountId);
            return stored?.state === 'active' && stored.marketId === market.marketId;
          }),
        ),
      ),
  };

  readonly challengeRepository: SignInChallengeRepository = {
    add: (_market, challenge, tokenHash) => {
      this.challenges.set(challenge.id, { challenge, tokenHash: hex(tokenHash) });
      return Promise.resolve();
    },
    findByTokenHash: (market, tokenHash) => {
      const wanted = hex(tokenHash);
      const found = [...this.challenges.values()].find(
        (entry) => entry.tokenHash === wanted && entry.challenge.marketId === market.marketId,
      );
      return Promise.resolve(found?.challenge ?? null);
    },
    reserveAttempt: (market, id, maxAttempts, now) => {
      const entry = this.challenges.get(id);
      const challenge = entry?.challenge;
      if (
        entry === undefined ||
        challenge === undefined ||
        challenge.marketId !== market.marketId ||
        challenge.consumedAt !== null ||
        challenge.attempts >= maxAttempts ||
        Temporal.Instant.compare(challenge.expiresAt, now) <= 0
      ) {
        return Promise.resolve(false);
      }
      entry.challenge = { ...challenge, attempts: challenge.attempts + 1 };
      return Promise.resolve(true);
    },
    consume: (market, id, now) => {
      const entry = this.challenges.get(id);
      const challenge = entry?.challenge;
      if (
        entry === undefined ||
        challenge === undefined ||
        challenge.marketId !== market.marketId ||
        challenge.consumedAt !== null ||
        Temporal.Instant.compare(challenge.expiresAt, now) <= 0
      ) {
        return Promise.resolve(false);
      }
      entry.challenge = { ...challenge, consumedAt: now };
      return Promise.resolve(true);
    },
    voidAllOf: (market, accountId) => {
      let count = 0;
      for (const [id, entry] of this.challenges) {
        if (
          entry.challenge.accountId === accountId &&
          entry.challenge.marketId === market.marketId
        ) {
          this.challenges.delete(id);
          count += 1;
        }
      }
      return Promise.resolve(count);
    },
    purgeExpired: () => Promise.resolve(0),
  };

  readonly invitationRepository: InvitationRepository = {
    findById: (market, id) => {
      const state = this.invitations.get(id);
      return Promise.resolve(
        state === undefined || state.marketId !== market.marketId
          ? null
          : Invitation.restore(state),
      );
    },
    findByTokenHash: (market, tokenHash) => {
      const wanted = hex(tokenHash);
      const state = [...this.invitations.values()].find(
        (candidate) =>
          candidate.marketId === market.marketId &&
          candidate.tokenHash !== null &&
          hex(candidate.tokenHash) === wanted,
      );
      return Promise.resolve(state === undefined ? null : Invitation.restore(state));
    },
    pendingInvitations: (market, kind, after, limit) =>
      Promise.resolve(
        [...this.invitations.values()]
          .filter(
            (candidate) =>
              candidate.marketId === market.marketId &&
              candidate.kind === kind &&
              candidate.state === 'pending' &&
              (after === null || candidate.id > after),
          )
          .sort((a, b) => (a.id < b.id ? -1 : 1))
          .slice(0, limit)
          .map((state) => ({
            id: state.id,
            state: 'pending' as const,
            email: state.email?.typed ?? '',
            roleId: state.roleId,
            invitedByAccountId: state.invitedByAccountId,
            expiresAt: state.expiresAt,
            createdAt: state.createdAt,
          })),
      ),
    findPendingFor: (market, kind, emailNormalized) => {
      const state = [...this.invitations.values()].find(
        (candidate) =>
          candidate.marketId === market.marketId &&
          candidate.state === 'pending' &&
          candidate.kind === kind &&
          candidate.email?.normalized === emailNormalized,
      );
      return Promise.resolve(state === undefined ? null : Invitation.restore(state));
    },
    add: (_market, invitation) => {
      const state = invitation.state;
      // invitations_market_id_kind_email_pending_key.
      const clash = [...this.invitations.values()].some(
        (other) =>
          other.state === 'pending' &&
          other.marketId === state.marketId &&
          other.kind === state.kind &&
          other.email !== null &&
          other.email.normalized === state.email?.normalized,
      );
      if (clash) return Promise.reject(new InvitationAlreadyPendingError());
      this.invitations.set(state.id, state);
      return Promise.resolve();
    },
    save: (_market, invitation) => {
      const state = invitation.state;
      if (state.version === invitation.persistedVersion) return Promise.resolve();
      if (this.invitations.get(state.id)?.version !== invitation.persistedVersion) {
        return Promise.reject(new StaleAggregateError('invitation', state.id));
      }
      this.invitations.set(state.id, state);
      return Promise.resolve();
    },
    purge: () => Promise.resolve(0),
  };

  readonly outbox: OutboxWriter = {
    append: (_context, events) => {
      this.events.push(...events);
      return Promise.resolve();
    },
  };

  /**
   * Identity's audit writer without a database: it records what it is given (the real writer
   * needs an open unit of the persistence layer; test/db/ covers it).
   */
  readonly audit: AuditWriter = {
    record: (context: CallContext, entry: AuditEntry) => {
      this.audits.push({
        ...entry,
        actor: context.actor.kind,
        marketId: context.market.marketId,
      });
      return Promise.resolve();
    },
  };

  /**
   * Identity's subject keys without a database (slice 7b): a stand-in with the port's contract
   * and none of its cryptography. "Ciphertext" names the Market, the subject and the field, so a
   * value bound to another one does not open; a destroyed subject answers `subject-key.destroyed`
   * and one that never had a key throws, as the service does (PF 4 rows 5 to 7).
   */
  readonly subjectKeyService: SubjectKeyService = {
    createKey: (_market: MarketContext, subject: Id) => {
      this.subjectKeys.set(subject, 'live');
      return Promise.resolve();
    },
    encrypt: (market: MarketContext, subject: Id, field: string, plain: string) =>
      this.keyed(subject, () => `fake1|${market.marketId}|${subject}|${field}|${plain}`),
    decrypt: (market: MarketContext, subject: Id, field: string, cipher: string) =>
      this.keyed(subject, () => {
        const [version, m, s, f, ...rest] = cipher.split('|');
        if (version !== 'fake1' || m !== market.marketId || s !== subject || f !== field) {
          throw new SubjectKeyIntegrityError('ciphertext-authentication');
        }
        return rest.join('|');
      }),
    hmac: (market: MarketContext, subject: Id, purpose: string, data: Uint8Array) =>
      this.keyed(subject, () =>
        createHmac('sha256', `${market.marketId}|${subject}|${purpose}`).update(data).digest('hex'),
      ),
    destroyKey: (_market: MarketContext, subject: Id) => {
      this.subjectKeys.set(subject, 'destroyed');
      return Promise.resolve();
    },
  };

  /** The second factor's secrets over the fake subject keys (the real adapter, slice 7b). */
  readonly secrets: SecondFactorSecrets = new SubjectKeySecondFactorSecrets(this.subjectKeyService);

  private keyed<T>(
    subject: Id,
    work: () => T,
  ): Promise<Result<T, { code: 'subject-key.destroyed' }>> {
    const key = this.subjectKeys.get(subject);
    if (key === undefined) return Promise.reject(new SubjectKeyMissingError());
    if (key === 'destroyed')
      return Promise.resolve(err({ code: 'subject-key.destroyed' as const }));
    try {
      return Promise.resolve(ok(work()));
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error('work failed'));
    }
  }

  readonly hasher: PasswordHasher = {
    hash: (plain: string): Promise<Result<string, PasswordHasherBusy>> => {
      if (this.busy) return Promise.resolve(err({ code: 'request.busy', retryAfterSeconds: 1 }));
      this.hashed += 1;
      return Promise.resolve(ok(fakeHashOf(plain)));
    },
    verify: (
      plain: string,
      stored: string | null,
    ): Promise<Result<PasswordVerification, PasswordHasherBusy>> => {
      if (this.busy) return Promise.resolve(err({ code: 'request.busy', retryAfterSeconds: 1 }));
      this.verified += 1;
      return Promise.resolve(
        ok({
          matches: stored !== null && stored === fakeHashOf(plain),
          needsRehash: this.needsRehash && stored === fakeHashOf(plain),
        }),
      );
    },
  };

  /** Replaces every database port of identity, and the hasher, with these fakes. */
  override(builder: TestingModuleBuilder): TestingModuleBuilder {
    return builder
      .overrideProvider(UNIT_OF_WORK)
      .useValue(this.unitOfWork)
      .overrideProvider(ACCOUNT_REPOSITORY)
      .useValue(this.accountRepository)
      .overrideProvider(SESSION_REPOSITORY)
      .useValue(this.sessionRepository)
      .overrideProvider(THROTTLE_REPOSITORY)
      .useValue(this.throttleRepository)
      .overrideProvider(SIGN_IN_RECORD_REPOSITORY)
      .useValue(this.recordRepository)
      .overrideProvider(OUTBOX_WRITER)
      .useValue(this.outbox)
      .overrideProvider(AUDIT_WRITER)
      .useValue(this.audit)
      .overrideProvider(ONE_TIME_LINK_REPOSITORY)
      .useValue(this.linkRepository)
      .overrideProvider(ADMIN_ACCOUNT_READER)
      .useValue(this.adminAccountReader)
      .overrideProvider(MERCHANT_REPOSITORY)
      .useValue(this.merchantRepository)
      .overrideProvider(MERCHANT_MEMBERSHIP_REPOSITORY)
      .useValue(this.membershipRepository)
      .overrideProvider(ROLE_REPOSITORY)
      .useValue(this.roleRepository)
      .overrideProvider(ROLE_ASSIGNMENT_REPOSITORY)
      .useValue(this.assignmentRepository)
      .overrideProvider(ROLE_GRANT_READER)
      .useValue(this.grantReader)
      .overrideProvider(SECOND_FACTOR_REPOSITORY)
      .useValue(this.factorRepository)
      .overrideProvider(SIGN_IN_CHALLENGE_REPOSITORY)
      .useValue(this.challengeRepository)
      .overrideProvider(INVITATION_REPOSITORY)
      .useValue(this.invitationRepository)
      .overrideProvider(MAIL_TRANSPORT)
      .useValue(this.mailTransport)
      .overrideProvider(SECOND_FACTOR_SECRETS)
      .useValue(this.secrets)
      .overrideProvider(PASSWORD_HASHER)
      .useValue(this.hasher);
  }
}
