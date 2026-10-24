import { MODULE_METADATA } from '@nestjs/common/constants';
import { testAppConfig } from '../../../test/support/test-config';
import { EVENT_BUS, OUTBOX_RELAY } from '../events/event-bus';
import { EVENT_DISPATCHER } from '../events/event-delivery';
import { RATE_LIMIT_COUNTERS } from '../rate-limit/rate-limit-counters';
import { JOB_LOCK } from '../scheduler/job-lock';
import { SUBJECT_KEY_STORE } from '../subject-keys/subject-key-store';
import { InvalidUnitOfWorkOptionsError } from '../unit-of-work/errors';
import { UNIT_OF_WORK, type UnitOfWorkOptions } from '../unit-of-work/unit-of-work';
import { DatabaseProbe } from './database-probe';
import { GUARDED_CLIENT } from './guarded-client';
import { PersistenceModule } from './persistence.module';
import { RAW_READ_BASE } from './raw-reads/prisma-raw-read-port';
import { RAW_READ_PORT } from './raw-reads/raw-read-port';
import { poolConfigOf, PrismaRoot } from './prisma-root';
import { PrismaService } from './prisma.service';
import { checkUnitOfWorkOptions } from './prisma-unit-of-work';

describe('PersistenceModule (platform persistence design 3.3)', () => {
  const providerTokens = (
    Reflect.getMetadata(MODULE_METADATA.PROVIDERS, PersistenceModule) as (
      { provide: unknown } | (new (...args: never[]) => unknown)
    )[]
  ).map((provider) => ('provide' in provider ? provider.provide : provider));

  it('exports the door for modules, the UnitOfWork port, the probe and the event, delivery, scheduler and rate-limit port implementations, and nothing else (no outbox writer factory)', () => {
    expect(Reflect.getMetadata(MODULE_METADATA.EXPORTS, PersistenceModule)).toEqual([
      PrismaService,
      UNIT_OF_WORK,
      DatabaseProbe,
      RAW_READ_BASE,
      EVENT_BUS,
      OUTBOX_RELAY,
      EVENT_DISPATCHER,
      JOB_LOCK,
      RATE_LIMIT_COUNTERS,
    ]);
  });

  it('binds the subject-key store only through its static factory, never as an export (PF 4 row 13)', () => {
    expect(providerTokens).not.toContain(SUBJECT_KEY_STORE);
    expect(PersistenceModule.subjectKeyStore().provide).toBe(SUBJECT_KEY_STORE);
  });

  it('binds a module raw read port only through its static factory, from the private base token (Hassan R-1)', () => {
    expect(providerTokens).toContain(RAW_READ_BASE);
    expect(providerTokens).not.toContain(RAW_READ_PORT);
    const provider = PersistenceModule.rawReadFor('certification');
    expect(provider.provide).toBe(RAW_READ_PORT);
    // Injected, not looked up, so Nest orders the async base before this provider (H1).
    expect(provider.inject).toEqual([RAW_READ_BASE]);
    expect(() => PersistenceModule.rawReadFor('Bad Name')).toThrow();
  });

  it('provides the base client and the guarded client without exporting them', () => {
    expect(providerTokens).toEqual(
      expect.arrayContaining([PrismaRoot, GUARDED_CLIENT, PrismaService, UNIT_OF_WORK]),
    );
  });
});

describe('poolConfigOf (3.1 row 8; data platform.md 10.9)', () => {
  it('bounds the wait for a connection at 2 s and sets an explicit maximum', () => {
    const config = testAppConfig({ DATABASE_POOL_MAX: '7' });

    expect(poolConfigOf(config)).toEqual({
      connectionString: config.databaseUrl,
      max: 7,
      connectionTimeoutMillis: 2000,
      idleTimeoutMillis: 30_000,
    });
  });

  it('takes a longer connection wait only when one is passed (database test harness)', () => {
    const config = testAppConfig();

    expect(poolConfigOf(config, 10_000).connectionTimeoutMillis).toBe(10_000);
    expect(poolConfigOf(config).connectionTimeoutMillis).toBe(2000);
  });

  it('defaults the maximum to 10 and never names prepared statements', () => {
    const pool = poolConfigOf(testAppConfig());

    expect(pool.max).toBe(10);
    expect(pool).not.toHaveProperty('statementNameGenerator');
  });
});

describe('checkUnitOfWorkOptions (3.1 rows 8 and 9; ADR-0025 condition (c))', () => {
  it.each<UnitOfWorkOptions>([
    {},
    { readOnly: true },
    { readOnly: false, isolation: 'serializable', timeoutMs: 30_000 },
    { timeoutMs: 1 },
    { lockTimeoutMs: 1 },
    { lockTimeoutMs: 3000, isolation: 'serializable' },
  ])('accepts %j', (options) => {
    expect(() => checkUnitOfWorkOptions(options)).not.toThrow();
  });

  it.each<[UnitOfWorkOptions, string]>([
    [{ readOnly: true, isolation: 'serializable' }, 'read-only-with-isolation'],
    [{ readOnly: true, timeoutMs: 100 }, 'read-only-with-timeout'],
    [{ isolation: 'read-committed' as never }, 'unknown-isolation'],
    [{ timeoutMs: 0 }, 'timeout-out-of-range'],
    [{ timeoutMs: 30_001 }, 'timeout-out-of-range'],
    [{ timeoutMs: 1.5 }, 'timeout-out-of-range'],
    [{ readOnly: true, lockTimeoutMs: 100 }, 'read-only-with-lock-timeout'],
    [{ lockTimeoutMs: 0 }, 'lock-timeout-out-of-range'],
    [{ lockTimeoutMs: 3001 }, 'lock-timeout-out-of-range'],
    [{ lockTimeoutMs: 1.5 }, 'lock-timeout-out-of-range'],
    [{ lockTimeoutMs: Number.NaN }, 'lock-timeout-out-of-range'],
  ])('refuses %j', (options, reason) => {
    expect(() => checkUnitOfWorkOptions(options)).toThrow(
      new InvalidUnitOfWorkOptionsError(reason as never),
    );
  });
});
