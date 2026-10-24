import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { databaseAccepted } from './check-database-role';
import { loadEnvFile } from './load-env-file';
import {
  AUDIT_VERIFY_EXIT,
  failureLine,
  runAuditVerifyCommand,
} from './platform/audit/audit-verify-command';
import { InvalidConfigError, loadAppConfig } from './platform/config/app-config';
import { DatabaseProbe } from './platform/persistence/database-probe';

/**
 * The operator command `audit-verify --market <id> [--full]` of the api image
 * (docs/design/domain/platform-audit.md 8):
 * `APP_ROLE=api node dist/audit-verify.js --market AU --full`. It loads the api's
 * configuration (so `APP_ROLE` is required, with no default), builds the same module graph,
 * runs the start-up self-checks, verifies the named Market's audit chain once (incremental
 * unless `--full`) and exits 0 when clean, 2 with findings (each also an alert line in the
 * log), 3 when the verification did not complete (budget spent, or an error after start-up),
 * 1 when refused (usage, an unhosted Market, a failed start). Nothing is written to
 * the database. No HTTP listener, no worker runtime.
 */
async function main(): Promise<number> {
  loadEnvFile();
  const config = loadAppConfig(process.env);
  const context = await NestFactory.createApplicationContext(AppModule.register({ config }), {
    bufferLogs: true,
  });
  try {
    const logger = context.get(Logger);
    context.useLogger(logger);
    if (!(await databaseAccepted(context.get(DatabaseProbe), logger))) {
      return AUDIT_VERIFY_EXIT.refused;
    }
    return await runAuditVerifyCommand(
      context,
      process.argv.slice(2),
      (line) => process.stdout.write(`${line}\n`),
      (line) => process.stderr.write(`${line}\n`),
    );
  } finally {
    await context.close();
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    // A failed start. Only the configuration's own text is printed (it names variables, never
    // values); any other error prints its class and SQLSTATE only (Mohammad 8).
    process.stderr.write(
      `${error instanceof InvalidConfigError ? error.message : failureLine(error, 'the start failed')}\n`,
    );
    process.exit(AUDIT_VERIFY_EXIT.refused);
  },
);
