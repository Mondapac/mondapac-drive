import { ROLE_TIMEOUT_CEILINGS_MS } from '../persistence/database-role-check';
import { MAX_RUN_MS } from '../scheduler/job-registry';
import { MAX_UNIT_TIMEOUT_MS } from '../unit-of-work/unit-of-work';
import {
  SEAL_JOB_MAX_RUN_MS,
  settleWindowHolds,
  settleWindowMs,
  VERIFY_JOB_MAX_RUN_MS,
} from './audit-chain-policy';

// ADR-0032 decision 3 and docs/design/domain/platform-audit.md 7.2 (Ali Q2, condition 1):
// S >= 4 x (MAX_UNIT_TIMEOUT + STATEMENT_TIMEOUT_CEILING). This test fails the build when a
// ceiling is raised without S. Raising either needs a CTO decision and a change to S in the
// same change; from the hardening trigger, `transaction_timeout` on the login roles joins the
// bound (PA 7.2, L4).

describe('the settle window S (ADR-0032 decision 3)', () => {
  const statementCeiling = ROLE_TIMEOUT_CEILINGS_MS.statement_timeout!;

  it('is 5 minutes', () => {
    expect(settleWindowMs()).toBe(300_000);
  });

  it('is at least four times the unit timeout ceiling plus the statement timeout ceiling', () => {
    expect(MAX_UNIT_TIMEOUT_MS).toBe(30_000);
    expect(statementCeiling).toBe(30_000);
    expect(settleWindowMs()).toBeGreaterThanOrEqual(4 * (MAX_UNIT_TIMEOUT_MS + statementCeiling));
    expect(settleWindowHolds(MAX_UNIT_TIMEOUT_MS, statementCeiling)).toBe(true);
  });

  it('stops holding when a ceiling is raised without S', () => {
    expect(settleWindowHolds(MAX_UNIT_TIMEOUT_MS + 1, statementCeiling + 15_000)).toBe(false);
    expect(settleWindowHolds(60_000, 30_000)).toBe(false);
  });

  it('gives the jobs run times the scheduler accepts', () => {
    expect(SEAL_JOB_MAX_RUN_MS).toBeLessThanOrEqual(MAX_RUN_MS);
    expect(VERIFY_JOB_MAX_RUN_MS).toBeLessThanOrEqual(MAX_RUN_MS);
  });
});
