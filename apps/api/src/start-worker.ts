import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { databaseAccepted } from './check-database-role';
import type { AppConfig } from './platform/config/app-config';
import { DatabaseProbe } from './platform/persistence/database-probe';
import { WorkerRuntime } from './platform/worker/worker-runtime';
import type { StartOptions } from './start-api';

/** A started worker: its application context and runtime, and the way to stop both. */
export interface StartedWorker {
  readonly context: INestApplicationContext;
  readonly runtime: WorkerRuntime;
  /** Stops the runtime (no new pass; up to 10 s for what is in flight), then closes the graph. */
  stop(): Promise<void>;
}

/**
 * The `worker` role (platform persistence design, "P", 8): the same module graph as the api
 * (`AppModule.register()`), built as an application context with no HTTP listener, so it has
 * no API surface. After the same start-up self-checks it starts `WorkerRuntime`: the relay and
 * the scheduler. Returns `undefined`, with the context closed, when a self-check refuses.
 *
 * The runtime stops before the graph closes, so the pass in flight still has its database
 * pool; `main.ts` wires SIGTERM and SIGINT to {@link StartedWorker.stop}.
 */
export async function startWorker(
  config: AppConfig,
  options: StartOptions = {},
): Promise<StartedWorker | undefined> {
  const context = await NestFactory.createApplicationContext(
    AppModule.register({ config, logDestination: options.logDestination }),
    { bufferLogs: true },
  );
  const logger = context.get(Logger);
  context.useLogger(logger);

  if (!(await databaseAccepted(context.get(DatabaseProbe), logger))) {
    await context.close();
    return undefined;
  }

  const runtime = context.get(WorkerRuntime);
  await runtime.start();
  let stopping: Promise<void> | undefined;
  return {
    context,
    runtime,
    stop: () =>
      (stopping ??= (async () => {
        await runtime.stop();
        await context.close();
      })()),
  };
}
