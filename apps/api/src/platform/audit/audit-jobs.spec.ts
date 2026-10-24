import { Temporal } from '@mondapac-drive/shared-kernel';
import {
  FixedClock,
  testCallContext,
  testMarketContext,
} from '@mondapac-drive/shared-kernel/testing';
import { TEST_MARKETS } from '../../../test/support/test-config';
import { PLATFORM_TENANT_ID } from '../market-context/tenant';
import type { JobContext } from '../scheduler/job-registry';
import { AUDIT_SEAL_JOB, AUDIT_VERIFY_JOB, auditSealJob, auditVerifyJob } from './audit-jobs';
import type { AuditSealer } from './audit-sealer';
import type { AuditVerifier, VerifyMode } from './audit-verifier';

// The two jobs of docs/design/domain/platform-audit.md 7 and 8: their schedule, and the
// verify job's choice of a full or an incremental run per Market.

const START = Temporal.Instant.from('2026-10-08T06:00:00Z');
const jobContextOf = (code: string) =>
  testCallContext(testMarketContext(code, PLATFORM_TENANT_ID), 'system') as JobContext;

describe('the audit jobs', () => {
  it('seal every 10 s from the worker start, at most 60 s a run', async () => {
    const run = jest.fn().mockResolvedValue(undefined);
    const job = auditSealJob({ run } as unknown as AuditSealer);
    expect(job).toMatchObject({ name: AUDIT_SEAL_JOB, runAtStart: true, maxRunMs: 60_000 });
    expect(job.every.total('seconds')).toBe(10);

    const context = jobContextOf('AU');
    await job.run(context);
    expect(run).toHaveBeenCalledWith(context);
  });

  it('verify hourly: full on the first run per Market and once a day, incremental between', async () => {
    const clock = new FixedClock(START);
    const modes: [string, VerifyMode][] = [];
    const verify = jest.fn((context: JobContext, mode: VerifyMode) => {
      modes.push([context.market.marketId, mode]);
      return Promise.resolve({ complete: true });
    });
    const job = auditVerifyJob({ verify } as unknown as AuditVerifier, clock);
    expect(job.name).toBe(AUDIT_VERIFY_JOB);
    expect(job.every.total('hours')).toBe(1);

    const [first, second] = TEST_MARKETS;
    await job.run(jobContextOf(first));
    clock.advance(Temporal.Duration.from({ hours: 1 }));
    await job.run(jobContextOf(first));
    await job.run(jobContextOf(second));
    clock.advance(Temporal.Duration.from({ hours: 23 }));
    await job.run(jobContextOf(first));
    await job.run(jobContextOf(second));

    expect(modes).toEqual([
      [first, 'full'],
      [first, 'incremental'],
      [second, 'full'],
      [first, 'full'],
      [second, 'incremental'],
    ]);
  });

  it('runs the next verification full again when a full one failed', async () => {
    const clock = new FixedClock(START);
    const modes: VerifyMode[] = [];
    const verify = jest
      .fn()
      .mockImplementationOnce((_context: JobContext, mode: VerifyMode) => {
        modes.push(mode);
        return Promise.reject(new Error('database gone'));
      })
      .mockImplementation((_context: JobContext, mode: VerifyMode) => {
        modes.push(mode);
        return Promise.resolve({ complete: true });
      });
    const job = auditVerifyJob({ verify } as unknown as AuditVerifier, clock);

    await expect(job.run(jobContextOf('AU'))).rejects.toThrow('database gone');
    await job.run(jobContextOf('AU'));
    expect(modes).toEqual(['full', 'full']);
  });

  it('runs the next verification full again when a full one ran out of its budget (Mohammad C1)', async () => {
    const clock = new FixedClock(START);
    const modes: VerifyMode[] = [];
    const verify = jest
      .fn()
      .mockImplementationOnce((_context: JobContext, mode: VerifyMode) => {
        modes.push(mode);
        return Promise.resolve({ complete: false });
      })
      .mockImplementation((_context: JobContext, mode: VerifyMode) => {
        modes.push(mode);
        return Promise.resolve({ complete: true });
      });
    const job = auditVerifyJob({ verify } as unknown as AuditVerifier, clock);

    await job.run(jobContextOf('AU'));
    clock.advance(Temporal.Duration.from({ hours: 1 }));
    await job.run(jobContextOf('AU'));
    clock.advance(Temporal.Duration.from({ hours: 1 }));
    await job.run(jobContextOf('AU'));

    expect(modes).toEqual(['full', 'full', 'incremental']);
  });
});
