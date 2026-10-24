import type { LoggerService } from '@nestjs/common';
import { databaseIsolationAccepted, databaseRoleAccepted } from './check-database-role';
import type { DatabaseProbe } from './platform/persistence/database-probe';

function recordingLogger(): { logger: LoggerService; errors: unknown[][] } {
  const errors: unknown[][] = [];
  const logger: LoggerService = {
    log: () => undefined,
    warn: () => undefined,
    error: (...args: unknown[]) => void errors.push(args),
  };
  return { logger, errors };
}

describe('databaseRoleAccepted', () => {
  it('accepts a role without problems and logs nothing', async () => {
    const { logger, errors } = recordingLogger();

    await expect(
      databaseRoleAccepted({ roleProblems: () => Promise.resolve([]) }, logger),
    ).resolves.toBe(true);
    expect(errors).toEqual([]);
  });

  it('refuses a role with problems and logs each reason code with its subject', async () => {
    const { logger, errors } = recordingLogger();
    const problems: Awaited<ReturnType<DatabaseProbe['roleProblems']>> = [
      { code: 'create_on_database', subject: null },
      { code: 'role_attribute', subject: 'rolsuper' },
    ];

    await expect(
      databaseRoleAccepted({ roleProblems: () => Promise.resolve(problems) }, logger),
    ).resolves.toBe(false);
    expect(errors).toEqual([
      [
        'The database role was refused by the start-up self-check: create_on_database, role_attribute(rolsuper)',
        'DatabaseRoleCheck',
      ],
    ]);
  });

  it('lets an error while running the check propagate, so start-up fails', async () => {
    const { logger } = recordingLogger();
    const failing = { roleProblems: () => Promise.reject(new Error('connection refused')) };

    await expect(databaseRoleAccepted(failing, logger)).rejects.toThrow('connection refused');
  });
});

describe('databaseIsolationAccepted (ADR-0025 decision 2)', () => {
  const probe = (isolation: string) => ({
    defaultTransactionIsolation: () => Promise.resolve(isolation),
  });

  it('accepts read committed and logs nothing', async () => {
    const { logger, errors } = recordingLogger();

    await expect(databaseIsolationAccepted(probe('read committed'), logger)).resolves.toBe(true);
    expect(errors).toEqual([]);
  });

  it.each(['serializable', 'repeatable read', 'read uncommitted'])(
    'refuses %s with a logged reason',
    async (isolation) => {
      const { logger, errors } = recordingLogger();

      await expect(databaseIsolationAccepted(probe(isolation), logger)).resolves.toBe(false);
      expect(errors).toEqual([
        [
          `The database was refused by the start-up self-check: default_transaction_isolation is "${isolation}", not "read committed" (ADR-0025)`,
          'DatabaseIsolationCheck',
        ],
      ]);
    },
  );

  it('does not echo an unexpected value', async () => {
    const { logger, errors } = recordingLogger();

    await databaseIsolationAccepted(probe('"; DROP TABLE x; --'), logger);

    expect(JSON.stringify(errors)).toContain('unrecognised');
    expect(JSON.stringify(errors)).not.toContain('DROP');
  });
});
