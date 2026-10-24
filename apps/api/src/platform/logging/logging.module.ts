import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Module, type DynamicModule } from '@nestjs/common';
import { parseCorrelationId } from '@mondapac-drive/shared-kernel';
import type { CorrelationId } from '@mondapac-drive/shared-kernel';
import { LoggerModule } from 'nestjs-pino';
import { pino, type DestinationStream } from 'pino';
import { pinoHttp, type HttpLogger } from 'pino-http';
import type { AppConfig } from '../config/app-config';
import { APP_CONFIG } from '../config/config.module';
import { CORRELATION_ID_HEADER } from './correlation-id';
import { LOG_FORMATTERS, LOG_HOOKS, LOG_SERIALIZERS } from './log-serializers';

/**
 * The caller's `x-correlation-id` when it fits the kernel's rule, as `clientRequestId`
 * (ADR-0020 decision 8). It is added to the one completion line of a request and goes
 * nowhere else; a malformed or repeated value is dropped.
 */
function clientRequestIdOf(req: IncomingMessage): { clientRequestId?: CorrelationId } {
  const incoming = req.headers[CORRELATION_ID_HEADER];
  if (typeof incoming !== 'string') return {};
  const parsed = parseCorrelationId(incoming);
  return parsed.ok ? { clientRequestId: parsed.value } : {};
}

/** Injection token for the request logger, the `pino-http` middleware `configureApp` mounts. */
export const HTTP_LOGGER = Symbol('HTTP_LOGGER');

/**
 * The one pino logger of the application and the request logger built on it. The request
 * logger is mounted by `configureApp` ahead of the body parser, so a request the parser
 * rejects is still logged with its correlation id (slice 0 item 5, Security L4).
 */
function createHttpLogger(config: AppConfig, destination?: DestinationStream): HttpLogger {
  const options = {
    level: config.logLevel,
    serializers: LOG_SERIALIZERS,
    hooks: LOG_HOOKS,
    formatters: LOG_FORMATTERS,
  };
  const logger = destination ? pino(options, destination) : pino(options);
  return pinoHttp({
    logger,
    // pino-http replaces a missing serializer with its own, which copies every property
    // of an error (body-parser's `body` among them); so the same set is given here.
    serializers: LOG_SERIALIZERS,
    genReqId: (_req: IncomingMessage, res: ServerResponse) => {
      const id = randomUUID();
      res.setHeader(CORRELATION_ID_HEADER, id);
      return id;
    },
    // A request ends with exactly one of these two lines.
    customSuccessObject: (req: IncomingMessage, _res: ServerResponse, value: object) => ({
      ...value,
      ...clientRequestIdOf(req),
    }),
    customErrorObject: (
      req: IncomingMessage,
      _res: ServerResponse,
      _error: Error,
      value: object,
    ) => ({
      ...value,
      ...clientRequestIdOf(req),
    }),
    // Top-level field on every line logged while handling the request.
    customProps: (req: IncomingMessage) => ({ correlationId: req.id }),
  });
}

@Module({})
class HttpLoggerModule {
  static forRoot(destination?: DestinationStream): DynamicModule {
    return {
      module: HttpLoggerModule,
      providers: [
        {
          provide: HTTP_LOGGER,
          inject: [APP_CONFIG],
          useFactory: (config: AppConfig) => createHttpLogger(config, destination),
        },
      ],
      exports: [HTTP_LOGGER],
    };
  }
}

@Module({})
export class LoggingModule {
  /**
   * Structured JSON logging. Every request gets a generated correlation id (a random UUID;
   * never the caller's), returned in the `x-correlation-id` response header and attached to
   * every log line written while handling that request. Headers are never logged, the path
   * without its query string, an error by its type only (`log-serializers.ts`).
   *
   * Nest's own logger (`nestjs-pino`) writes through the same pino logger, inside a request
   * and outside one, with the same serializers; it does not mount a middleware of its own
   * (`useExisting`), because the request logger must run before the body parser.
   *
   * @param destination where log lines go; defaults to stdout. Tests pass a stream.
   */
  static forRoot(destination?: DestinationStream): DynamicModule {
    const httpLogger = HttpLoggerModule.forRoot(destination);
    return {
      module: LoggingModule,
      imports: [
        httpLogger,
        LoggerModule.forRootAsync({
          imports: [httpLogger],
          inject: [HTTP_LOGGER],
          useFactory: (http: HttpLogger) => ({
            pinoHttp: { logger: http.logger, serializers: LOG_SERIALIZERS },
            useExisting: true,
          }),
        }),
      ],
      exports: [LoggerModule, httpLogger],
    };
  }
}
