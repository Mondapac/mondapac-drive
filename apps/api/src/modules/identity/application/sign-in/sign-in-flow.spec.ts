import { createHash } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { Temporal } from '@mondapac-drive/shared-kernel';
import type { Id, MarketContext, Result } from '@mondapac-drive/shared-kernel';
import {
  FixedClock,
  SequenceIdGenerator,
  testCallContext,
  testMarketContext,
} from '@mondapac-drive/shared-kernel/testing';
import { fakeHashOf, IdentityFakes } from '../../../../../test/support/identity-fakes';
import {
  TEST_MARKET_CONFIG_DIRS,
  TEST_MARKET_IDS,
  TEST_MARKETS,
} from '../../../../../test/support/test-config';
import { createUseCaseGate } from '../../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import { PLATFORM_TENANT_ID } from '../../../../platform/market-context/tenant';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import type { AccountState } from '../../domain/account';
import { MarketConfigIdentityPolicy } from '../../infrastructure/market-config-identity-policy';
import type { PasswordHasher } from '../ports/password-hasher';
import type { SessionTokens, ThrottleKeys } from '../ports/session-secrets';
import { SignInCourier } from '../use-cases/sign-in-courier.use-case';

// The invariants of the shared sign-in sequence (identity design 6.3, 6.8; HF1, HF12; Hassan L1,
// Sajad gap 1 of slice 5), for the population that signs in with a password alone (couriers; an
// admin adds a second step, a merchant has API keys only) and both Market fixtures: one dummy
// hash for an unknown address, the same steps for every refusal before the password is known
// right, the throttle block and its wait, and fail-closed answers when the counters or the
// closing unit cannot be reached.

const START = Temporal.Instant.from('2026-10-08T10:00:00Z');
const PASSWORD = 'correct horse battery staple';
const EMAIL = 'Person@Example.com';
const CLIENT = { origin: '203.0.113.7', address: '203.0.113.7' };
const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const policy = new MarketConfigIdentityPolicy(markets);

const keys: ThrottleKeys = {
  account: (market, population, email) => Buffer.from(`${market.marketId}|${population}|${email}`),
  accountOrigin: (market, population, email, origin) =>
    Buffer.from(`${market.marketId}|${population}|${email}|${origin}`),
  origin: (market, origin) => Buffer.from(`${market.marketId}|${origin}`),
};

const tokens: SessionTokens = {
  issue: () => {
    const token = `ms1_${'T'.repeat(43)}`;
    return { token, tokenHash: new Uint8Array(createHash('sha256').update(token).digest()) };
  },
  hashOf: (token) => new Uint8Array(createHash('sha256').update(token).digest()),
};

type Step = 'unit' | 'verify' | 'hash';

function setUp() {
  const fakes = new IdentityFakes();
  const steps: Step[] = [];
  const clock = new FixedClock(START);
  const unitOfWork: UnitOfWork = {
    run: <T, E>(market: MarketContext, work: () => Promise<Result<T, E>>) => {
      steps.push('unit');
      return fakes.unitOfWork.run(market, work);
    },
    runOnce: (m, delivery, work, options) => fakes.unitOfWork.runOnce(m, delivery, work, options),
  };
  const hasher: PasswordHasher = {
    hash: (plain) => {
      steps.push('hash');
      return fakes.hasher.hash(plain);
    },
    verify: (plain, stored) => {
      steps.push('verify');
      return fakes.hasher.verify(plain, stored);
    },
  };
  const deps = {
    unitOfWork,
    accounts: fakes.accountRepository,
    sessions: fakes.sessionRepository,
    throttles: fakes.throttleRepository,
    records: fakes.recordRepository,
    hasher,
    tokens,
    keys,
    policy,
    clock,
    ids: new SequenceIdGenerator(clock),
  };
  const gate = createUseCaseGate(markets, null);
  const useCase = new SignInCourier(gate, deps);
  return { fakes, steps, clock, useCase };
}

describe.each(TEST_MARKETS)('the shared sign-in sequence for couriers in market %s', (code) => {
  const population = 'courier' as const;
  const market = testMarketContext(code, PLATFORM_TENANT_ID);
  const context = testCallContext(market, 'anonymous', 'sign-in-flow-0001');
  const rule = policy.signInThrottles(market).accountOrigin;
  const marketId = code as AccountState['marketId'];
  let warnings: jest.SpyInstance;

  beforeEach(() => {
    warnings = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => warnings.mockRestore());

  const execute = (
    s: ReturnType<typeof setUp>,
    fields: { email?: string; password?: string; client?: typeof CLIENT } = {},
  ) =>
    s.useCase.execute(context, {
      email: fields.email ?? EMAIL,
      password: fields.password ?? PASSWORD,
      client: fields.client ?? CLIENT,
    });

  /** A courier account. */
  function seed(fakes: IdentityFakes, overrides: Partial<AccountState> = {}): void {
    const id = `01992222-0000-7000-8000-${code === 'AU' ? '0000000000a1' : '0000000000b1'}`;
    fakes.seedAccount({
      id: id as Id<'Account'>,
      marketId,
      population,
      email: { typed: EMAIL, normalized: EMAIL.toLowerCase() },
      displayName: 'Amina',
      status: 'active',
      emailVerifiedAt: START.subtract({ hours: 1 }),
      signedUpAt: START.subtract({ hours: 2 }),
      createdAt: START.subtract({ hours: 2 }),
      version: 2,
      credential: { passwordHash: fakeHashOf(PASSWORD), changedAt: START.subtract({ hours: 2 }) },
      ...overrides,
    });
  }

  it('signs in with the right password (the baseline of the cases below)', async () => {
    const s = setUp();
    seed(s.fakes);

    await expect(execute(s)).resolves.toMatchObject({ ok: true });
    expect(s.steps).toEqual(['unit', 'verify', 'unit']);
  });

  it('answers credentials.invalid to an unknown address after one dummy verification (HF12)', async () => {
    const s = setUp();

    await expect(execute(s)).resolves.toEqual({
      ok: false,
      error: { code: 'credentials.invalid' },
    });
    expect(s.fakes.verified).toBe(1);
    expect(s.fakes.records.map((r) => [r.population, r.outcome, r.accountId])).toEqual([
      [population, 'credentials.invalid', null],
    ]);
  });

  it('costs the same for an unknown address, a wrong password and an unverified account (HF12)', async () => {
    const paths: Step[][] = [];
    for (const [arrange, password] of [
      [() => undefined, PASSWORD],
      [(fakes: IdentityFakes) => seed(fakes), `${PASSWORD}!`],
      [(fakes: IdentityFakes) => seed(fakes, { emailVerifiedAt: null }), PASSWORD],
    ] as const) {
      const s = setUp();
      arrange(s.fakes);
      await execute(s, { password });
      paths.push(s.steps);
    }

    expect(paths).toEqual([
      ['unit', 'verify', 'unit'],
      ['unit', 'verify', 'unit'],
      ['unit', 'verify', 'unit'],
    ]);
  });

  it("blocks at the Market's limit: request.throttled with the wait, even for the right password, hashing nothing", async () => {
    const s = setUp();
    seed(s.fakes);
    for (let n = 0; n < rule.limit; n += 1) await execute(s, { password: 'wrong' });
    s.steps.length = 0;
    s.clock.advance(Temporal.Duration.from({ seconds: 30 }));

    await expect(execute(s)).resolves.toEqual({
      ok: false,
      error: { code: 'request.throttled', retryAfterSeconds: rule.blockMinutes * 60 - 30 },
    });
    expect(s.steps).toEqual(['unit']);
    expect(s.fakes.sessions.size).toBe(0);
    expect(s.fakes.records.at(-1)).toMatchObject({ population, outcome: 'request.throttled' });
  });

  it('answers the same throttle to an unknown address', async () => {
    const s = setUp();
    for (let n = 0; n < rule.limit; n += 1) await execute(s, { password: 'wrong' });

    await expect(execute(s)).resolves.toMatchObject({
      ok: false,
      error: { code: 'request.throttled' },
    });
  });

  it('fails closed with access.unavailable when the counters cannot be reached, hashing nothing', async () => {
    const s = setUp();
    seed(s.fakes);
    s.fakes.throttlesDown = true;

    await expect(execute(s)).resolves.toEqual({
      ok: false,
      error: { code: 'access.unavailable' },
    });
    expect(s.steps).toEqual(['unit']);
    expect(warnings).toHaveBeenCalledWith(
      expect.objectContaining({ msg: 'identity.sign-in.throttle-unavailable', marketId: code }),
    );
  });

  it('fails closed with access.unavailable when the closing unit throws, opening no session', async () => {
    const s = setUp();
    seed(s.fakes);
    s.fakes.sessionRepository.add = () => Promise.reject(new Error('session table unreachable'));

    await expect(execute(s)).resolves.toEqual({
      ok: false,
      error: { code: 'access.unavailable' },
    });
    expect(s.fakes.sessions.size).toBe(0);
  });

  it('answers request.busy when the hash queue is full and gives the reservation back', async () => {
    const s = setUp();
    seed(s.fakes);
    s.fakes.busy = true;

    await expect(execute(s)).resolves.toEqual({
      ok: false,
      error: { code: 'request.busy', retryAfterSeconds: 1 },
    });
    expect([...s.fakes.throttles.values()].every((row) => row.attempts === 0)).toBe(true);
  });

  it('answers credentials.invalid for an account of the other population with that email (AC 3)', async () => {
    const s = setUp();
    seed(s.fakes);
    const [stored] = [...s.fakes.accounts.values()];
    s.fakes.seedAccount({
      ...stored!,
      population: 'admin',
    });

    await expect(execute(s)).resolves.toEqual({
      ok: false,
      error: { code: 'credentials.invalid' },
    });
  });
});
