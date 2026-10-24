import type { IncomingHttpHeaders, OutgoingHttpHeaders, Server } from 'node:http';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Writable } from 'node:stream';
import type { INestApplication, Type } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test, type TestingModuleBuilder } from '@nestjs/testing';
import { Logger } from 'nestjs-pino';
import { AppModule } from '../../src/app.module';
import { APP_OPTIONS, configureApp } from '../../src/configure-app';
import { RATE_LIMIT_COUNTERS } from '../../src/platform/rate-limit/rate-limit-counters';
import { MemoryRateLimitCounters } from './memory-rate-limit-counters';
import { panelOriginMarketConfigDirs, testAppConfig } from './test-config';

// nestjs-pino builds its pino-http instance once per module registry, so in one Jest test
// file only the first application's log destination receives lines. A spec file that
// asserts on log lines therefore boots exactly one application.

/** One JSON log line written by the application. */
export interface LogLine {
  readonly level?: number;
  readonly msg?: string;
  readonly correlationId?: string;
  readonly clientRequestId?: string;
  readonly req?: Record<string, unknown>;
  readonly res?: Record<string, unknown>;
  readonly [field: string]: unknown;
}

export interface TestApp {
  readonly app: NestExpressApplication;
  /** Every log line written so far; tests may empty it between cases. */
  readonly logLines: LogLine[];
}

export interface TestAppOptions {
  /** Environment overrides for {@link testAppConfig}. */
  readonly env?: Record<string, string>;
  /** Test-only controllers registered next to the application's own. */
  readonly controllers?: readonly Type[];
  /** Replaces providers before compiling (e.g. fakes of the database ports in a no-database suite). */
  readonly override?: (builder: TestingModuleBuilder) => TestingModuleBuilder;
  /**
   * Fills an empty admin origin list with the dispatch panel's origin
   * ({@link panelOriginMarketConfigDirs}), so a test can send unsafe requests to admin routes
   * with `panelHeaders`.
   */
  readonly panelOrigins?: boolean;
  /**
   * Where the rate limiter counts: `memory` (the default) gives each application counters of
   * its own, so suites without a database run and parallel database suites never share a
   * window; `postgres` keeps the application's PostgreSQL store (the rate-limit database suite).
   */
  readonly rateLimitStore?: 'memory' | 'postgres';
}

/**
 * Boots the real AppModule with the shared HTTP setup of `configureApp`, so what is tested
 * is what runs, and captures the log lines as objects.
 */
export async function createTestApp(options: TestAppOptions = {}): Promise<TestApp> {
  const logLines: LogLine[] = [];
  const logDestination = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      for (const line of chunk.toString().split('\n').filter(Boolean)) {
        logLines.push(JSON.parse(line) as LogLine);
      }
      callback();
    },
  });

  const base = testAppConfig(options.env);
  const config = options.panelOrigins
    ? { ...base, marketConfigDirs: panelOriginMarketConfigDirs() }
    : base;
  const created = Test.createTestingModule({
    imports: [AppModule.register({ config, logDestination })],
    controllers: [...(options.controllers ?? [])],
  });
  const builder =
    options.rateLimitStore === 'postgres'
      ? created
      : created.overrideProvider(RATE_LIMIT_COUNTERS).useValue(new MemoryRateLimitCounters());
  const moduleRef = await (options.override ? options.override(builder) : builder).compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>(APP_OPTIONS);
  app.useLogger(app.get(Logger));
  configureApp(app);
  await app.init();
  return { app, logLines };
}

/**
 * The one completion line ("request completed" or "request errored") of the response that
 * carried `correlationId`. It fails when that line was not captured, so an assertion that
 * something is absent from the logs can never pass on empty logs.
 */
export function completionLineOf<L extends { correlationId?: unknown; msg?: unknown }>(
  logLines: readonly L[],
  correlationId: string | undefined,
): L {
  const lines = logLines.filter(
    (line) =>
      line.correlationId === correlationId &&
      (line.msg === 'request completed' || line.msg === 'request errored'),
  );
  if (correlationId === undefined || lines.length !== 1) {
    throw new Error(
      `expected one captured completion line for correlation id ${String(correlationId)}, ` +
        `found ${lines.length} among ${logLines.length} lines`,
    );
  }
  return lines[0]!;
}

export interface RawResponse {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly text: string;
  /** The request's header lines as the server received them (`req.rawHeaders`). */
  readonly receivedRawHeaders: readonly string[];
}

/**
 * A GET request sent with Node's own client, so a header given as an array goes out as
 * repeated header lines (superagent's array behaviour is undocumented). The server's view of
 * the lines is returned too, so a test can prove they arrived repeated.
 */
export async function rawGet(
  app: INestApplication,
  path: string,
  headers: OutgoingHttpHeaders,
): Promise<RawResponse> {
  const server = app.getHttpServer() as Server;
  const opened = !server.listening;
  if (opened) {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  }

  let receivedRawHeaders: readonly string[] = [];
  const capture = (incoming: { rawHeaders: string[] }) => {
    receivedRawHeaders = [...incoming.rawHeaders];
  };
  server.prependListener('request', capture);
  try {
    const { port } = server.address() as AddressInfo;
    return await new Promise<RawResponse>((resolve, reject) => {
      const outgoing = httpRequest(
        { host: '127.0.0.1', port, path, method: 'GET', headers, agent: false },
        (response) => {
          let text = '';
          response.setEncoding('utf8');
          response.on('data', (chunk: string) => (text += chunk));
          response.on('end', () =>
            resolve({
              status: response.statusCode ?? 0,
              headers: response.headers,
              text,
              receivedRawHeaders,
            }),
          );
        },
      );
      outgoing.on('error', reject);
      outgoing.end();
    });
  } finally {
    server.removeListener('request', capture);
    if (opened) {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  }
}

/** How many header lines named `name` the server received. */
export function receivedCount(response: RawResponse, name: string): number {
  return response.receivedRawHeaders.filter(
    (value, index) => index % 2 === 0 && value.toLowerCase() === name,
  ).length;
}
