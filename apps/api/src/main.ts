import 'reflect-metadata';
import { loadEnvFile } from './load-env-file';
import { loadAppConfig } from './platform/config/app-config';
import { startApi } from './start-api';
import { startWorker } from './start-worker';

/**
 * The composition root (platform persistence design, "P", 8). It reads `APP_ROLE` and
 * branches once: `api` serves HTTP, `worker` runs the relay and the scheduler. Both build the
 * same module graph. Only this file and `platform/worker/` read the role (P 12.2 rule 3).
 *
 * A missing or unknown `APP_ROLE` fails boot here, before either role starts (no default;
 * main.spec.ts). The worker exits 0 after a clean stop on SIGTERM or SIGINT and 1 if the stop
 * fails; its path never calls `enableShutdownHooks`, so nothing re-raises the signal.
 */
async function bootstrap(): Promise<void> {
  loadEnvFile();
  const config = loadAppConfig(process.env);

  if (config.appRole === 'worker') {
    const worker = await startWorker(config);
    if (worker === undefined) process.exit(1);
    for (const signal of ['SIGTERM', 'SIGINT'] as const) {
      process.once(signal, () => {
        worker.stop().then(
          () => process.exit(0),
          () => process.exit(1),
        );
      });
    }
    return;
  }

  const api = await startApi(config);
  if (api === undefined) process.exit(1);
}

bootstrap().catch((error: unknown) => {
  // Startup failures (for example invalid configuration) happen before the logger exists.
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
