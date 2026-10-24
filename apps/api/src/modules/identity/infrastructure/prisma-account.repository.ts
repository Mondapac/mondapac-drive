import { err, ok, parseMarketId, POPULATIONS, Temporal } from '@mondapac-drive/shared-kernel';
import type { Id, MarketContext, Population, Result } from '@mondapac-drive/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type { SubjectKeyService } from '../../../platform/subject-keys/subject-key-service';
import { StaleAggregateError } from '../../../platform/unit-of-work/errors';
import type { AccountAddRefused, AccountRepository } from '../application/ports/account.repository';
import { Account, type AccountState } from '../domain/account';

/** Constraint names this repository turns into domain errors (data design 3.3, N1). */
const EMAIL_TAKEN = 'accounts_market_id_population_email_normalized_key';
const VALIDATION_CHECKS = new Set([
  'accounts_display_name_check',
  'accounts_email_check',
  'accounts_email_normalized_check',
  'password_credentials_password_hash_check',
]);

const toDate = (instant: Temporal.Instant): Date => new Date(instant.epochMilliseconds);
const toInstant = (date: Date): Temporal.Instant =>
  Temporal.Instant.fromEpochMilliseconds(date.getTime());
const toOptionalInstant = (date: Date | null): Temporal.Instant | null =>
  date === null ? null : toInstant(date);

/** The account columns read; the credential comes from its own table (never in a list). */
const SELECTED = {
  id: true,
  marketId: true,
  population: true,
  email: true,
  emailNormalized: true,
  displayName: true,
  timezone: true,
  locale: true,
  status: true,
  emailVerifiedAt: true,
  signedUpAt: true,
  version: true,
  createdAt: true,
  passwordCredential: { select: { passwordHash: true, changedAt: true } },
} as const;

/** One account row as {@link SELECTED} reads it. */
interface SelectedRow {
  readonly id: string;
  readonly marketId: string;
  readonly population: string;
  readonly email: string;
  readonly emailNormalized: string;
  readonly displayName: string;
  readonly timezone: string | null;
  readonly locale: string | null;
  readonly status: string;
  readonly emailVerifiedAt: Date | null;
  readonly signedUpAt: Date;
  readonly version: number;
  readonly createdAt: Date;
  readonly passwordCredential: { readonly passwordHash: string; readonly changedAt: Date } | null;
}

/**
 * {@link AccountRepository} on `identity.accounts` and `identity.password_credentials` (data
 * design 3.3). Every statement goes through `PrismaService.tx(market)` with `marketId` at the
 * top level of `where`, so the market guard checks it (P 4); writes are single statements per
 * table, never nested (C10). A known constraint violation becomes a domain error; nothing of
 * the driver error is logged or returned (I15).
 */
export class PrismaAccountRepository implements AccountRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly subjectKeys: SubjectKeyService,
  ) {}

  async findByEmail(
    market: MarketContext,
    population: Population,
    emailNormalized: string,
  ): Promise<Account | null> {
    const row = await this.prisma.tx(market).identityAccount.findFirst({
      where: { marketId: market.marketId, population, emailNormalized },
      select: SELECTED,
    });
    return row === null ? null : this.restore(row);
  }

  async findById(market: MarketContext, id: Id<'Account'>): Promise<Account | null> {
    const row = await this.prisma.tx(market).identityAccount.findFirst({
      where: { marketId: market.marketId, id },
      select: SELECTED,
    });
    return row === null ? null : this.restore(row);
  }

  async lockCredential(market: MarketContext, id: Id<'Account'>): Promise<boolean> {
    // An UPDATE that changes no value takes the row's write lock (FOR NO KEY UPDATE strength)
    // until the unit ends; a concurrent holder makes this statement wait, under the login
    // role's lock_timeout (55P03 is a TransactionConflictError at once, P 3.1 row 7). It writes
    // a new row version and touches no index column, so it is HOT-eligible (measured 97.7 % in
    // steady state; data design 3.3).
    const { count } = await this.prisma.tx(market).identityAccount.updateMany({
      where: { marketId: market.marketId, id },
      data: { version: { increment: 0 } },
    });
    return count === 1;
  }

  async existsInPopulation(market: MarketContext, population: Population): Promise<boolean> {
    const row = await this.prisma.tx(market).identityAccount.findFirst({
      where: { marketId: market.marketId, population },
      select: { id: true },
    });
    return row !== null;
  }

  private restore(row: SelectedRow): Account {
    const credential = row.passwordCredential;
    const marketId = parseMarketId(row.marketId);
    if (
      credential === null ||
      !marketId.ok ||
      !(POPULATIONS as readonly string[]).includes(row.population) ||
      (row.status !== 'active' && row.status !== 'disabled')
    ) {
      // The database guarantees at most one credential, not exactly one (data design 5).
      throw new Error('identity.accounts: a stored account is incomplete or malformed');
    }
    const state: AccountState = {
      id: row.id as Id<'Account'>,
      marketId: marketId.value,
      population: row.population as Population,
      email: { typed: row.email, normalized: row.emailNormalized },
      displayName: row.displayName,
      timezone: row.timezone,
      locale: row.locale,
      status: row.status,
      emailVerifiedAt: toOptionalInstant(row.emailVerifiedAt),
      signedUpAt: toInstant(row.signedUpAt),
      createdAt: toInstant(row.createdAt),
      version: row.version,
      credential: {
        passwordHash: credential.passwordHash,
        changedAt: toInstant(credential.changedAt),
      },
    };
    return Account.restore(state);
  }

  async add(market: MarketContext, account: Account): Promise<Result<void, AccountAddRefused>> {
    const state = account.state;
    const transaction = this.prisma.tx(market);
    try {
      await this.subjectKeys.createKey(market, state.id);
      await transaction.identityAccount.create({
        data: {
          id: state.id,
          marketId: market.marketId,
          tenantId: market.tenantId,
          population: state.population,
          email: state.email.typed,
          emailNormalized: state.email.normalized,
          displayName: state.displayName,
          status: state.status,
          emailVerifiedAt: state.emailVerifiedAt === null ? null : toDate(state.emailVerifiedAt),
          signedUpAt: toDate(state.signedUpAt),
          version: state.version,
          createdAt: toDate(state.createdAt),
        },
        select: { id: true },
      });
      await transaction.identityPasswordCredential.create({
        data: {
          marketId: market.marketId,
          tenantId: market.tenantId,
          accountId: state.id,
          passwordHash: state.credential.passwordHash,
          changedAt: toDate(state.credential.changedAt),
        },
        select: { accountId: true },
      });
      return ok(undefined);
    } catch (error) {
      const constraint = this.prisma.violatedConstraint(error);
      if (constraint === EMAIL_TAKEN) return err({ code: 'account.email-taken' });
      if (constraint !== null && VALIDATION_CHECKS.has(constraint)) {
        return err({ code: 'validation.failed' });
      }
      throw error;
    }
  }

  async save(market: MarketContext, account: Account): Promise<void> {
    const state = account.state;
    const expected = account.persistedVersion;
    if (expected === null) throw new Error('save: the account was never stored; use add');
    if (state.version === expected) return;
    const transaction = this.prisma.tx(market);
    const { count } = await transaction.identityAccount.updateMany({
      where: { marketId: market.marketId, id: state.id, version: expected },
      data: {
        displayName: state.displayName,
        timezone: state.timezone ?? null,
        locale: state.locale ?? null,
        // Slice 8b: disable and enable. Written under the version guard, in the caller's
        // serializable unit (HF8: every writer of accounts.status).
        status: state.status,
        emailVerifiedAt: state.emailVerifiedAt === null ? null : toDate(state.emailVerifiedAt),
        signedUpAt: toDate(state.signedUpAt),
        version: state.version,
      },
    });
    if (count !== 1) throw new StaleAggregateError('account', state.id);
    // A change of the credential goes through its root, whose version rose above (data 3.3);
    // the row is rewritten only when the credential changed (Mojtaba N-b).
    if (!account.credentialChanged) return;
    await transaction.identityPasswordCredential.updateMany({
      where: { marketId: market.marketId, accountId: state.id },
      data: {
        passwordHash: state.credential.passwordHash,
        changedAt: toDate(state.credential.changedAt),
      },
    });
  }
}
