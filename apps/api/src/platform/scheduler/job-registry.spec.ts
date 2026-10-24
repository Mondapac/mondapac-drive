import { Temporal } from '@mondapac-drive/shared-kernel';
import * as jobLock from './job-lock';
import {
  intervalMsOf,
  JobRegistry,
  JobRegistryError,
  registerJobs,
  registerJobsFrom,
  type JobDefinition,
} from './job-registry';

const job = (name: string, overrides: Partial<JobDefinition> = {}): JobDefinition => ({
  name,
  every: Temporal.Duration.from({ hours: 1 }),
  run: () => Promise.resolve(),
  ...overrides,
});

describe('JobRegistry (platform persistence design 7)', () => {
  it('holds the jobs a module registers, by name, and lists them sorted', () => {
    const registry = new JobRegistry();
    registry.register('identity', [job('identity.purge-expired'), job('identity.b-job')]);

    expect(registry.get('identity.purge-expired')?.name).toBe('identity.purge-expired');
    expect(registry.names()).toEqual(['identity.b-job', 'identity.purge-expired']);
  });

  it.each([
    ['another module', 'sellers.purge'],
    ['no job segment', 'identity'],
    ['upper case', 'identity.Purge'],
    ['a third segment', 'identity.purge.expired'],
  ])('fails boot on a name with %s', (_case, name) => {
    expect(() => new JobRegistry().register('identity', [job(name)])).toThrow(JobRegistryError);
  });

  it('fails boot on a duplicate', () => {
    const registry = new JobRegistry();
    registry.register('identity', [job('identity.purge-expired')]);

    expect(() => registry.register('identity', [job('identity.purge-expired')])).toThrow(
      /registered twice/,
    );
  });

  it.each<[string, Partial<JobDefinition>]>([
    ['an interval under 1 s', { every: Temporal.Duration.from({ milliseconds: 999 }) }],
    ['a calendar interval', { every: Temporal.Duration.from({ months: 1 }) }],
    ['maxRunMs 0', { maxRunMs: 0 }],
    ['maxRunMs above 600000', { maxRunMs: 600_001 }],
    ['a fractional maxRunMs', { maxRunMs: 1.5 }],
  ])('fails boot on %s', (_case, overrides) => {
    expect(() =>
      new JobRegistry().register('identity', [job('identity.purge-expired', overrides)]),
    ).toThrow(JobRegistryError);
  });

  it("fails boot on a job whose lock key is Prisma Migrate's (PM8)", () => {
    const spy = jest.spyOn(jobLock, 'jobLockKey').mockReturnValue(jobLock.PRISMA_MIGRATE_LOCK_KEY);
    try {
      expect(() => new JobRegistry().register('identity', [job('identity.purge-expired')])).toThrow(
        /lock key of Prisma Migrate/,
      );
    } finally {
      spy.mockRestore();
    }
  });

  it('is sealed when the application has bootstrapped', () => {
    const registry = new JobRegistry();
    registry.onApplicationBootstrap();

    expect(() => registry.register('identity', [job('identity.purge-expired')])).toThrow(/sealed/);
  });

  it('registers through the one provider line a module adds', () => {
    const registry = new JobRegistry();
    const provider = registerJobs('identity', [job('identity.purge-expired')]) as {
      inject: unknown[];
      useFactory: (registry: JobRegistry) => unknown;
    };

    expect(provider.inject).toEqual([JobRegistry]);
    provider.useFactory(registry);
    expect(registry.names()).toEqual(['identity.purge-expired']);
  });

  it('registers jobs built from providers of the module', () => {
    const registry = new JobRegistry();
    const USE_CASE = Symbol('USE_CASE');
    const provider = registerJobsFrom('identity', [USE_CASE], (name: string) => [job(name)]) as {
      inject: unknown[];
      useFactory: (registry: JobRegistry, ...dependencies: unknown[]) => unknown;
    };

    expect(provider.inject).toEqual([JobRegistry, USE_CASE]);
    provider.useFactory(registry, 'identity.purge-expired');
    expect(registry.names()).toEqual(['identity.purge-expired']);
  });
});

describe('intervalMsOf', () => {
  it('reads days, hours, minutes and seconds', () => {
    expect(intervalMsOf({ every: Temporal.Duration.from({ hours: 1 }) })).toBe(3_600_000);
    expect(intervalMsOf({ every: Temporal.Duration.from({ days: 1 }) })).toBe(86_400_000);
  });
});
