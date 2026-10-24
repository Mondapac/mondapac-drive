import type { INestApplication } from '@nestjs/common';
import { ok } from '@mondapac-drive/shared-kernel';
import type { Clock, Id, IdGenerator, MarketContext } from '@mondapac-drive/shared-kernel';
import {
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac-drive/shared-kernel/testing';
import { ACCOUNT_REPOSITORY } from '../../src/modules/identity/application/ports/account.repository';
import type { AccountRepository } from '../../src/modules/identity/application/ports/account.repository';
import {
  ROLE_ASSIGNMENT_REPOSITORY,
  ROLE_REPOSITORY,
} from '../../src/modules/identity/application/ports/role.repository';
import type {
  RoleAssignmentRepository,
  RoleRepository,
} from '../../src/modules/identity/application/ports/role.repository';
import { SESSION_TOKENS } from '../../src/modules/identity/application/ports/session-secrets';
import type { SessionTokens } from '../../src/modules/identity/application/ports/session-secrets';
import { SESSION_REPOSITORY } from '../../src/modules/identity/application/ports/session.repository';
import type { SessionRepository } from '../../src/modules/identity/application/ports/session.repository';
import { CreateMerchant } from '../../src/modules/identity/application/use-cases/create-merchant.use-case';
import { IssueMerchantApiKey } from '../../src/modules/identity/application/use-cases/merchant-api-keys.use-case';
import { SeedRoles } from '../../src/modules/identity/application/use-cases/seed-roles.use-case';
import { Account } from '../../src/modules/identity/domain/account';
import { parseEmailAddress } from '../../src/modules/identity/domain/email-address';
import { RoleAssignment } from '../../src/modules/identity/domain/role';
import { openSession } from '../../src/modules/identity/domain/session';
import { CSRF_HEADER, csrfTokenFor } from '../../src/platform/call-context/csrf';
import { sessionCookieName } from '../../src/platform/call-context/session-cookie';
import { CLOCK } from '../../src/platform/clock/clock.module';
import { ID_GENERATOR } from '../../src/platform/ids/ids.module';
import { PLATFORM_TENANT_ID } from '../../src/platform/market-context/tenant';
import { UNIT_OF_WORK } from '../../src/platform/unit-of-work/unit-of-work';
import type { UnitOfWork } from '../../src/platform/unit-of-work/unit-of-work';

// Signed-in actors for database specs that call the HTTP API, made through identity's own
// repositories and use cases on the real database: an admin holding a platform role (with a
// cookie session and its CSRF token), merchants created by that admin with an API key each,
// and couriers with a bearer session. Admin sign-in itself (password and second factor) is
// covered by identity's own specs; here the session row is opened directly.

const LIFETIME = { idleTimeoutSeconds: 3600, absoluteLifetimeSeconds: 7200 };
/** Never checked: the account was founded here, not signed in with a password. */
const UNUSED_PASSWORD_HASH = '$argon2id$v=19$m=19456,t=2,p=1$dW51c2Vk$dW51c2VkdW51c2VkdW51c2Vk';

export interface AdminActor {
  readonly accountId: Id<'Account'>;
  /** The cookie, CSRF and panel origin headers of an unsafe admin request. */
  readonly headers: Readonly<Record<string, string>>;
}

export interface MerchantActor {
  readonly merchantId: Id<'Merchant'>;
  readonly headers: Readonly<Record<string, string>>;
}

export interface CourierActor {
  readonly accountId: Id<'Account'>;
  readonly headers: Readonly<Record<string, string>>;
}

/** The actors of one Market of a booted test application. */
export class TestActors {
  readonly #app: INestApplication;
  readonly market: MarketContext;
  readonly #ids: IdGenerator;
  readonly #clock: Clock;
  readonly #unit: UnitOfWork;

  constructor(app: INestApplication, code: string) {
    this.#app = app;
    this.market = testMarketContext(code, PLATFORM_TENANT_ID);
    this.#ids = app.get<IdGenerator>(ID_GENERATOR, { strict: false });
    this.#clock = app.get<Clock>(CLOCK, { strict: false });
    this.#unit = app.get<UnitOfWork>(UNIT_OF_WORK, { strict: false });
  }

  #get<T>(token: symbol): T {
    return this.#app.get<T>(token, { strict: false });
  }

  /** Seeds the Market's roles (idempotent, as at every boot). */
  async seedRoles(): Promise<void> {
    const seeded = await this.#app
      .get(SeedRoles, { strict: false })
      .execute(testCallContext(this.market, 'system', `actors-seed-${this.#ids.next()}`), {});
    if (!seeded.ok) throw new Error(`seed roles: ${seeded.error.code}`);
  }

  /**
   * An admin holding a seeded platform role (Platform Administrator by default) or a custom role
   * given by id, with a cookie session.
   */
  async admin(
    origin: string,
    role: string | { readonly roleId: Id<'Role'> } = 'platform-administrator',
  ): Promise<AdminActor> {
    const accountId = await this.#account('admin', 'platform', role);
    const token = await this.#session(accountId, 'admin', 'cookie');
    return {
      accountId,
      headers: {
        cookie: `${sessionCookieName('admin', this.market.marketId)}=${token}`,
        [CSRF_HEADER]: csrfTokenFor(token),
        origin,
        'sec-fetch-site': 'same-origin',
      },
    };
  }

  /** A merchant created by `admin`, with one API key. */
  async merchant(admin: AdminActor, name: string): Promise<MerchantActor> {
    const context = this.#as(admin.accountId);
    const created = await this.#app
      .get(CreateMerchant, { strict: false })
      .execute(context, { name });
    if (!created.ok) throw new Error(`create merchant: ${created.error.code}`);
    const { merchantId } = created.value;
    const issued = await this.#app
      .get(IssueMerchantApiKey, { strict: false })
      .execute(context, { merchantId, label: 'Marketplace' });
    if (!issued.ok) throw new Error(`issue key: ${issued.error.code}`);
    return { merchantId, headers: { authorization: `Bearer ${issued.value.key}` } };
  }

  /** A courier with its founded role and a bearer session of the courier app. */
  async courier(): Promise<CourierActor> {
    const accountId = await this.#account('courier', 'courier', 'courier');
    const token = await this.#session(accountId, 'courier', 'bearer');
    return { accountId, headers: { authorization: `Bearer ${token}` } };
  }

  #as(accountId: Id<'Account'>) {
    return testCallContext(
      this.market,
      testAuthenticatedActor(this.market, {
        population: 'admin',
        accountId,
        sessionId: this.#ids.next<'Session'>(),
        merchantId: null,
      }),
      `actors-${this.#ids.next()}`,
    );
  }

  async #account(
    population: 'admin' | 'courier',
    scope: 'platform' | 'courier',
    seedCode: string | { readonly roleId: Id<'Role'> },
  ): Promise<Id<'Account'>> {
    const id = this.#ids.next<'Account'>();
    const email = parseEmailAddress(`${population}-${id}@example.com`);
    if (!email.ok) throw new Error('bad email');
    const now = this.#clock.now();
    const done = await this.#unit.run(this.market, async () => {
      const account = Account.acceptInvitation({
        id,
        marketId: this.market.marketId,
        population,
        email: email.value,
        displayName: `Test ${population}`,
        passwordHash: UNUSED_PASSWORD_HASH,
        now,
      });
      const added = await this.#get<AccountRepository>(ACCOUNT_REPOSITORY).add(
        this.market,
        account,
      );
      if (!added.ok) throw new Error(`add account: ${added.error.code}`);
      const roles = this.#get<RoleRepository>(ROLE_REPOSITORY);
      const role =
        typeof seedCode === 'string'
          ? await roles.findBySeedCode(this.market, scope, seedCode)
          : await roles.findById(this.market, seedCode.roleId);
      if (role === null) throw new Error(`no role ${scope}:${JSON.stringify(seedCode)}`);
      const assignment = role.isSystem
        ? RoleAssignment.found({ id: this.#ids.next(), account: account.state, role, now })
        : RoleAssignment.grant({
            id: this.#ids.next(),
            account: account.state,
            role,
            assignedBy: id,
            now,
          });
      await this.#get<RoleAssignmentRepository>(ROLE_ASSIGNMENT_REPOSITORY).add(
        this.market,
        assignment,
      );
      return ok(undefined);
    });
    if (!done.ok) throw new Error('account unit failed');
    return id;
  }

  async #session(
    accountId: Id<'Account'>,
    population: 'admin' | 'courier',
    transport: 'cookie' | 'bearer',
  ): Promise<string> {
    const { token, tokenHash } = this.#get<SessionTokens>(SESSION_TOKENS).issue();
    const session = openSession({
      id: this.#ids.next<'Session'>(),
      marketId: this.market.marketId,
      accountId,
      population,
      transport,
      lifetime: LIFETIME,
      now: this.#clock.now(),
    });
    await this.#unit.run(this.market, async () => {
      await this.#get<SessionRepository>(SESSION_REPOSITORY).add(this.market, session, tokenHash);
      return ok(undefined);
    });
    return token;
  }
}
