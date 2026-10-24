import type { NestApplicationOptions } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { SwaggerModule } from '@nestjs/swagger';
import type { Clock } from '@mondapac-drive/shared-kernel';
import type { HttpLogger } from 'pino-http';
import { buildOpenApiDocument } from './openapi';
import { CLOCK } from './platform/clock/clock.module';
import type { AppConfig } from './platform/config/app-config';
import { APP_CONFIG } from './platform/config/config.module';
import { answerBodyError } from './platform/http/body-errors';
import { clientAddressResolver } from './platform/http/client-address';
import { securityHeaders } from './platform/http/security-headers';
import { HTTP_LOGGER } from './platform/logging/logging.module';

/**
 * Options for creating the application, shared by the real server (main.ts) and the HTTP
 * tests. Nest's own body parser is off: `configureApp` mounts the parser after the request
 * logger (slice 0 item 5).
 */
export const APP_OPTIONS = {
  bufferLogs: true,
  bodyParser: false,
} as const satisfies NestApplicationOptions;

/**
 * HTTP-level setup shared by the real server (main.ts) and the HTTP tests, so what is
 * tested is what runs. The application must be created with {@link APP_OPTIONS}.
 *
 * Order: the request logger, the security headers, the client address (ADR-0037), the body
 * parser, then Nest's routes and guards. A request the parser rejects (malformed JSON, too
 * large) is therefore logged with its correlation id, and its answer carries the
 * `x-correlation-id` header (Security L4) and the security headers (item 6). A request whose
 * client address is refused is logged and carries the headers too, and its body is never parsed.
 */
export function configureApp(app: NestExpressApplication): void {
  const config = app.get<AppConfig>(APP_CONFIG);
  app.disable('x-powered-by');
  // No proxy is trusted: `req.ip` is the socket's address, and nothing reads it. Behind a BFF the
  // client address is proven by the BFF instead (ADR-0037); never `true` (slice 0 item 6).
  app.set('trust proxy', false);
  app.enableShutdownHooks();

  app.use(app.get<HttpLogger>(HTTP_LOGGER));
  app.use(securityHeaders({ docsEnabled: config.apiDocsEnabled }));
  app.use(
    clientAddressResolver({ trust: config.clientAddressTrust, clock: app.get<Clock>(CLOCK) }),
  );
  // JSON only, at most 64 KiB, objects and arrays only. No CORS middleware until origins exist.
  // inflate: false - a compressed body is refused with 415, never decompressed (Hassan L1).
  app.useBodyParser('json', { limit: '64kb', strict: true, inflate: false });
  app.use(answerBodyError);

  if (config.apiDocsEnabled) {
    SwaggerModule.setup('docs', app, buildOpenApiDocument(app));
  }
}
