import type { LoggerService } from '@nestjs/common';
import type { DatabaseProbe } from './platform/persistence/database-probe';

type RoleProblem = Awaited<ReturnType<DatabaseProbe['roleProblems']>>[number];

/**
 * The start-up self-check (docs/design/data/platform.md 10.8): `main.ts` runs it once,
 * before the server listens. It logs each reason code with its role or schema name, never
 * the URL, and answers whether the process may go on.
 */
export async function databaseRoleAccepted(
  probe: { roleProblems(): Promise<readonly RoleProblem[]> },
  logger: LoggerService,
): Promise<boolean> {
  const problems = await probe.roleProblems();
  if (problems.length === 0) return true;
  const reasons = problems.map(({ code, subject }) =>
    subject === null ? code : `${code}(${subject})`,
  );
  logger.error(
    `The database role was refused by the start-up self-check: ${reasons.join(', ')}`,
    'DatabaseRoleCheck',
  );
  return false;
}

/** The only default isolation the UnitOfWork accepts (ADR-0025 decision 2). */
export const REQUIRED_DEFAULT_ISOLATION = 'read committed';

/**
 * ADR-0025 decision 2: units pass no isolation level for READ COMMITTED, so the database's
 * default is a deployment fact. `main.ts` runs this once, as the API login, before the server
 * listens; anything but `read committed` stops the process with a logged reason. The value
 * logged is the setting's own (a PostgreSQL keyword), or `unrecognised` for anything else.
 */
export async function databaseIsolationAccepted(
  probe: { defaultTransactionIsolation(): Promise<string> },
  logger: LoggerService,
): Promise<boolean> {
  const isolation = await probe.defaultTransactionIsolation();
  if (isolation === REQUIRED_DEFAULT_ISOLATION) return true;
  const shown = /^[a-z ]{1,32}$/.test(isolation) ? isolation : 'unrecognised';
  logger.error(
    'The database was refused by the start-up self-check: default_transaction_isolation is ' +
      `"${shown}", not "${REQUIRED_DEFAULT_ISOLATION}" (ADR-0025)`,
    'DatabaseIsolationCheck',
  );
  return false;
}

/**
 * Both start-up self-checks, as each role runs them before doing anything: the database role
 * (10.8), then the default isolation (ADR-0025). False when either refuses; the reason is logged.
 */
export async function databaseAccepted(
  probe: {
    roleProblems(): Promise<readonly RoleProblem[]>;
    defaultTransactionIsolation(): Promise<string>;
  },
  logger: LoggerService,
): Promise<boolean> {
  return (
    (await databaseRoleAccepted(probe, logger)) && (await databaseIsolationAccepted(probe, logger))
  );
}
