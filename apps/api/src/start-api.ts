import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Logger } from 'nestjs-pino';
import type { DestinationStream } from 'pino';
import { AppModule } from './app.module';
import { databaseAccepted } from './check-database-role';
import { APP_OPTIONS, configureApp } from './configure-app';
import type { AppConfig } from './platform/config/app-config';
import { DatabaseProbe } from './platform/persistence/database-probe';

/** Where a start function writes its log lines; stdout unless a test passes a stream. */
export interface StartOptions {
  readonly logDestination?: DestinationStream;
}

/**
 * The `api` role (platform persistence design, "P", 8): the HTTP server with its guards,
 * controllers and docs. It writes outbox rows; it never relays, dispatches or schedules.
 * Returns `undefined`, with the application closed, when the start-up self-check refuses.
 */
export async function startApi(
  config: AppConfig,
  options: StartOptions = {},
): Promise<NestExpressApplication | undefined> {
  const app = await NestFactory.create<NestExpressApplication>(
    AppModule.register({ config, logDestination: options.logDestination }),
    APP_OPTIONS,
  );
  const logger = app.get(Logger);
  app.useLogger(logger);
  configureApp(app);

  // Before listening, so a mis-wired database secret never serves a request (10.8), and a
  // database whose default isolation is not READ COMMITTED never runs a unit (ADR-0025).
  if (!(await databaseAccepted(app.get(DatabaseProbe), logger))) {
    await app.close();
    return undefined;
  }

  await app.listen(config.port);
  return app;
}
