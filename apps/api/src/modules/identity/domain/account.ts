import { err, ok, Temporal } from '@mondapac-drive/shared-kernel';
import type { Id, MarketId, PendingEvent, Population, Result } from '@mondapac-drive/shared-kernel';
import type { EmailAddress } from './email-address';
import type { PASSWORD_CHANGE_CAUSES } from './events';
import {
  AccountDisabled,
  AccountEnabled,
  AccountDisplayNameChanged,
  AccountOtherSessionsSignedOut,
  AccountPasswordChanged,
} from './events';

/** Why a password was replaced: a reset link, or the holder's own change (identity design 3.7). */
export type PasswordChangeCause = (typeof PASSWORD_CHANGE_CAUSES)[number];

/** The account may not take a new password now: disabled, or its email never verified (3.7). */
export type AccountNotEligible = { readonly code: 'account.not-eligible' };

/**
 * Why a disable or an enable changed nothing (identity design 3.1; slice 8b): the account is
 * already in that state, or it is a merchant's account, which this path never touches (the
 * merchant is suspended instead).
 */
export type AccountStatusRefused =
  | AccountNotEligible
  | { readonly code: 'account.already-disabled' }
  | { readonly code: 'account.already-active' };

/**
 * Why a change of an account's status to `to` would be refused, or null when it would not
 * (identity design 3.1; slices 8b and 8c): a merchant's account never changes status by this
 * path, and an account already in `to` changes nothing. The one rule of `Account.disable` and
 * `Account.enable`, and of the admin team list's hints, which read it without loading the account.
 */
export function statusChangeRefusal(
  population: Population,
  status: 'active' | 'disabled',
  to: 'active' | 'disabled',
): AccountStatusRefused | null {
  if (population === 'merchant') return { code: 'account.not-eligible' };
  if (status !== to) return null;
  return to === 'disabled'
    ? { code: 'account.already-disabled' }
    : { code: 'account.already-active' };
}

/** The password credential, an entity of the account: a PHC string and when it was set. */
export interface PasswordCredential {
  readonly passwordHash: string;
  readonly changedAt: Temporal.Instant;
}

/** The state of an {@link Account} (identity design 2.1; data design 3.3). */
export interface AccountState {
  readonly id: Id<'Account'>;
  readonly marketId: MarketId;
  readonly population: Population;
  readonly email: EmailAddress;
  /** Every account has one: a person's name, or a merchant's business name. */
  readonly displayName: string;
  /** The holder's own IANA time zone for showing times; null/absent = the panel's own rule. */
  readonly timezone?: string | null;
  /** The holder's panel language; null/absent = the Market's language. */
  readonly locale?: string | null;
  readonly status: 'active' | 'disabled';
  readonly emailVerifiedAt: Temporal.Instant | null;
  /** When the account was set up (an invitation's acceptance, a merchant's creation). */
  readonly signedUpAt: Temporal.Instant;
  readonly createdAt: Temporal.Instant;
  readonly version: number;
  readonly credential: PasswordCredential;
}

/** A state that breaks an invariant of 2.1: a bug of the caller or a corrupt row. */
export class AccountInvariantError extends Error {
  override readonly name = 'AccountInvariantError';
  constructor(readonly invariant: 'display-name-required') {
    super(`Account invariant broken: ${invariant}`);
  }
}

/**
 * The `Account` aggregate (marketplace identity design 2.1). One population for life, one
 * Market; the email is unique per Market and population (the database constraint). Every
 * account has a display name. Admin and courier accounts are created by accepting an
 * invitation; a merchant's integration account is created with its merchant, and holds a
 * password nobody knows. Times come from the caller's `Clock`; every change raises the version
 * by one and records at most one event (platform persistence 5.1).
 */
export class Account {
  #state: AccountState;
  #events: PendingEvent[] = [];
  /** The credential as read from the store (null for a new account), for {@link credentialChanged}. */
  readonly #storedCredential: PasswordCredential | null;

  private constructor(
    state: AccountState,
    /** The version read from the store; null for an account not stored yet. */
    readonly persistedVersion: number | null,
  ) {
    if (typeof state.displayName !== 'string' || state.displayName.trim() === '') {
      throw new AccountInvariantError('display-name-required');
    }
    this.#state = Object.freeze({ ...state });
    this.#storedCredential = persistedVersion === null ? null : this.#state.credential;
  }

  /**
   * Acceptance of an invitation (identity design 3.1, 3.2, 3.4; slice 7b for admins): an active
   * account, verified now because the invitation's link proved the mailbox, with exactly the
   * invited address and the display name the caller parsed (HF13). Admin and courier accounts
   * only: a merchant is never invited. No event: the invitation's
   * `identity.invitation-accepted.v1` names the account (8.2).
   */
  static acceptInvitation(input: {
    readonly id: Id<'Account'>;
    readonly marketId: MarketId;
    readonly population: 'admin' | 'courier';
    readonly email: EmailAddress;
    readonly displayName: string;
    readonly passwordHash: string;
    readonly now: Temporal.Instant;
  }): Account {
    const { id, marketId, population, email, displayName, passwordHash, now } = input;
    if (population !== 'admin' && population !== 'courier') {
      throw new TypeError('Account.acceptInvitation: only admin and courier accounts');
    }
    if (displayName.trim() === '') throw new AccountInvariantError('display-name-required');
    return new Account(
      {
        id,
        marketId,
        population,
        email: Object.freeze({ typed: email.typed, normalized: email.normalized }),
        displayName,
        status: 'active',
        emailVerifiedAt: now,
        signedUpAt: now,
        createdAt: now,
        version: 1,
        credential: Object.freeze({ passwordHash, changedAt: now }),
      },
      null,
    );
  }

  /**
   * The integration account of a new merchant: the principal its API keys act as. Active,
   * unverified (no mail is ever sent to it), named after the merchant, with the hash of a
   * random secret nobody holds, so it can never sign in with a password. No event: the
   * merchant's `identity.merchant-created.v1` names it.
   */
  static createMerchantIntegration(input: {
    readonly id: Id<'Account'>;
    readonly marketId: MarketId;
    readonly email: EmailAddress;
    readonly displayName: string;
    readonly passwordHash: string;
    readonly now: Temporal.Instant;
  }): Account {
    const { id, marketId, email, displayName, passwordHash, now } = input;
    return new Account(
      {
        id,
        marketId,
        population: 'merchant',
        email: Object.freeze({ typed: email.typed, normalized: email.normalized }),
        displayName,
        status: 'active',
        emailVerifiedAt: null,
        signedUpAt: now,
        createdAt: now,
        version: 1,
        credential: Object.freeze({ passwordHash, changedAt: now }),
      },
      null,
    );
  }

  /** An account read from the store. Checks the invariants again. */
  static restore(state: AccountState): Account {
    return new Account(state, state.version);
  }

  get state(): AccountState {
    return this.#state;
  }

  /** Whether the owner confirmed the email (identity design 3.2). */
  get isEmailVerified(): boolean {
    return this.#state.emailVerifiedAt !== null;
  }

  /**
   * Whether the credential differs from the one read from the store, so the repository writes
   * `password_credentials` only then (Mojtaba N-b). Always true for a new account.
   */
  get credentialChanged(): boolean {
    return this.#storedCredential !== this.#state.credential;
  }

  /** Events recorded since the account was built or restored. */
  get pendingEvents(): readonly PendingEvent[] {
    return [...this.#events];
  }

  /**
   * Replaces a hash made with older parameters after a successful sign-in (identity design 6.5).
   * The password is the same, so `changedAt` stays and no event is recorded; the version rises
   * by one, so a concurrent change of the account wins or loses as a whole (platform persistence
   * 5.1: at most one event per version step).
   */
  rehashPassword(passwordHash: string): void {
    const credential = this.#state.credential;
    if (passwordHash === credential.passwordHash) return;
    this.#state = Object.freeze({
      ...this.#state,
      credential: Object.freeze({ passwordHash, changedAt: credential.changedAt }),
      version: this.#state.version + 1,
    });
  }

  /**
   * Replaces the password (identity design 3.5, 3.7, 6.5; SEL-05, ACC-04, AC 8, AC 32; slice 4):
   * the new hash, made by the caller outside any unit, and `changedAt = now`. Records
   * `identity.account-password-changed.v1` with its cause. Only an active account whose email is
   * verified takes one: a reset link is never issued to, nor used for, a disabled or unverified
   * account (3.7; an unverified person signs up again, 3.2), and a change needs a session, which
   * only such an account has (3.5). The sessions are the caller's: it revokes them in the same
   * unit, after it took the account's credential lock (`AccountRepository.lockCredential`).
   */
  replacePassword(input: {
    readonly passwordHash: string;
    readonly now: Temporal.Instant;
    readonly cause: PasswordChangeCause;
  }): Result<void, AccountNotEligible> {
    const { passwordHash, now, cause } = input;
    if (this.#state.status !== 'active' || this.#state.emailVerifiedAt === null) {
      return err({ code: 'account.not-eligible' });
    }
    const version = this.#state.version + 1;
    this.#state = Object.freeze({
      ...this.#state,
      credential: Object.freeze({ passwordHash, changedAt: now }),
      version,
    });
    this.#events.push(
      AccountPasswordChanged.record({
        aggregateId: this.#state.id,
        aggregateVersion: version,
        occurredAt: now,
        payload: { accountId: this.#state.id, cause },
      }),
    );
    return ok(undefined);
  }

  /**
   * The holder replaces the own display name (profile package). Only an active, verified account
   * may change it. The name was parsed by
   * the caller (`parseDisplayName`, HF13). The same name changes nothing and records nothing; the
   * answer says whether this call changed it. Records `identity.account-display-name-changed.v1`.
   */
  rename(input: {
    readonly displayName: string;
    readonly now: Temporal.Instant;
  }): Result<boolean, AccountNotEligible> {
    const { displayName, now } = input;
    const state = this.#state;
    if (state.status !== 'active' || state.emailVerifiedAt === null) {
      return err({ code: 'account.not-eligible' });
    }
    if (displayName.trim() === '') throw new AccountInvariantError('display-name-required');
    if (state.displayName === displayName) return ok(false);
    const version = state.version + 1;
    this.#state = Object.freeze({ ...state, displayName, version });
    this.#events.push(
      AccountDisplayNameChanged.record({
        aggregateId: state.id,
        aggregateVersion: version,
        occurredAt: now,
        payload: { accountId: state.id, population: state.population },
      }),
    );
    return ok(true);
  }

  /**
   * The holder signed out the own other sessions (profile package 4), and at least one was
   * ended: a version step that records `identity.account-other-sessions-signed-out.v1`, which
   * sends the notice. The sessions themselves are revoked by the caller in the same unit.
   */
  recordOtherSessionsSignedOut(now: Temporal.Instant): void {
    const state = this.#state;
    const version = state.version + 1;
    this.#state = Object.freeze({ ...state, version });
    this.#events.push(
      AccountOtherSessionsSignedOut.record({
        aggregateId: state.id,
        aggregateVersion: version,
        occurredAt: now,
        payload: { accountId: state.id },
      }),
    );
  }

  /**
   * The holder sets the own display preferences (time zone, language), both already parsed by
   * the caller. Same values change nothing; the answer says whether this call changed them.
   * Records no event: nothing consumes them. Admin and courier accounts only.
   */
  setPreferences(input: {
    readonly timezone: string | null;
    readonly locale: string | null;
  }): Result<boolean, AccountNotEligible> {
    const state = this.#state;
    if (
      state.population === 'merchant' ||
      state.status !== 'active' ||
      state.emailVerifiedAt === null
    ) {
      return err({ code: 'account.not-eligible' });
    }
    if ((state.timezone ?? null) === input.timezone && (state.locale ?? null) === input.locale) {
      return ok(false);
    }
    this.#state = Object.freeze({
      ...state,
      timezone: input.timezone,
      locale: input.locale,
      version: state.version + 1,
    });
    return ok(true);
  }

  /**
   * `active` → `disabled` (identity design 3.1; AC 11, AC 18; slice 8b), by an admin. Records
   * `identity.account-disabled.v1`. Only an admin or a courier account: a merchant's account is
   * never disabled by this path (the merchant is suspended).
   * The guards that need other aggregates (not the actor itself, R1, the last full-access admin)
   * and the effects (every session revoked, open challenges void, in the same serializable unit)
   * belong to the use case.
   */
  disable(now: Temporal.Instant): Result<void, AccountStatusRefused> {
    const refused = statusChangeRefusal(this.#state.population, this.#state.status, 'disabled');
    if (refused !== null) return err(refused);
    this.changeStatus('disabled', now);
    return ok(undefined);
  }

  /** `disabled` → `active` (identity design 3.1; decided by Ali, 14.1-8): as {@link disable}. */
  enable(now: Temporal.Instant): Result<void, AccountStatusRefused> {
    const refused = statusChangeRefusal(this.#state.population, this.#state.status, 'active');
    if (refused !== null) return err(refused);
    this.changeStatus('active', now);
    return ok(undefined);
  }

  private changeStatus(status: 'active' | 'disabled', now: Temporal.Instant): void {
    const version = this.#state.version + 1;
    this.#state = Object.freeze({ ...this.#state, status, version });
    const definition = status === 'disabled' ? AccountDisabled : AccountEnabled;
    this.#events.push(
      definition.record({
        aggregateId: this.#state.id,
        aggregateVersion: version,
        occurredAt: now,
        payload: { accountId: this.#state.id, population: this.#state.population },
      }),
    );
  }
}
