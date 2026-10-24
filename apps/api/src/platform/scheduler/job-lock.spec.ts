import { jobLockKey, PRISMA_MIGRATE_LOCK_KEY } from './job-lock';

describe('jobLockKey (platform persistence design 7; PM8)', () => {
  it("gives identity's two jobs the keys Mojtaba measured (data design 10)", () => {
    expect(jobLockKey('identity.purge-expired')).toBe(6283714585531761361n);
    expect(jobLockKey('identity.purge-unverified-accounts')).toBe(5423381668565611002n);
  });

  it('is a signed 64-bit integer, stable, and different per name', () => {
    const key = jobLockKey('sellers.some-job');

    expect(key).toBe(jobLockKey('sellers.some-job'));
    expect(key).not.toBe(jobLockKey('sellers.other-job'));
    expect(BigInt.asIntN(64, key)).toBe(key);
  });

  it('never equals the session lock key Prisma Migrate holds (72707369), for the jobs we know', () => {
    for (const name of ['identity.purge-expired', 'identity.purge-unverified-accounts']) {
      expect(jobLockKey(name)).not.toBe(PRISMA_MIGRATE_LOCK_KEY);
    }
  });
});
