import { APP_GUARD, ModulesContainer, type ApplicationConfig } from '@nestjs/core';
import { GLOBAL_MODULE_METADATA, MODULE_METADATA } from '@nestjs/common/constants';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { parseCorrelationId } from '@mondapac-drive/shared-kernel';
import request from 'supertest';
import { AppModule, GLOBAL_GUARDS } from '../src/app.module';
import { buildOpenApiDocument } from '../src/openapi';
import { ClockModule, CLOCK } from '../src/platform/clock/clock.module';
import { SystemClock } from '../src/platform/clock/system-clock';
import { IdsModule, ID_GENERATOR } from '../src/platform/ids/ids.module';
import { UuidV7IdGenerator } from '../src/platform/ids/uuid-v7-id-generator';
import { MarketContextFactory } from '../src/platform/market-context/market-context.factory';
import { MarketContextGuard } from '../src/platform/market-context/market-context.guard';
import { MarketContextModule } from '../src/platform/market-context/market-context.module';
import { RateLimitGuard } from '../src/platform/rate-limit/rate-limit.guard';
import {
  ExemptMarketReaderController,
  MarketEchoController,
} from './support/market-test.controllers';
import {
  completionLineOf,
  createTestApp,
  rawGet,
  receivedCount,
  type LogLine,
} from './support/test-app';
import { TEST_MARKETS } from './support/test-config';

const HEADER = 'x-market-id';
/** Well formed, hosted by no Region Stack of the tests. */
const NOT_HOSTED = 'QQ_LEAK7';

const missing = { statusCode: 400, code: 'market.header-missing' };
const invalid = { statusCode: 400, code: 'market.header-invalid' };
const notHosted = { statusCode: 400, code: 'market.not-hosted' };

/**
 * Asserts a value reached neither the response nor any log line. The request's own
 * completion line must have been captured first, so the check cannot pass on empty logs.
 */
function expectNowhere(value: string, response: request.Response, logLines: LogLine[]): void {
  completionLineOf(logLines, response.headers['x-correlation-id'] as string);
  expect(response.text).not.toContain(value);
  // The fixed security headers (item 6) are left out: "default-src" contains "au".
  const headers = Object.entries(response.headers).filter(
    ([name]) => name !== 'content-security-policy',
  );
  expect(JSON.stringify(headers)).not.toContain(value);
  expect(JSON.stringify(logLines)).not.toContain(value);
}

// One application per file: nestjs-pino keeps one logger per Jest module registry, so a
// second application here would leave these log assertions without lines. The residency
// and API-docs cases live in market-residency.e2e.spec.ts and api-docs.e2e.spec.ts.
describe('market resolution (HTTP, platform-foundations 5.1)', () => {
  let app: NestExpressApplication;
  let logLines: LogLine[];
  const get = (path: string) => request(app.getHttpServer()).get(path);

  beforeAll(async () => {
    ({ app, logLines } = await createTestApp({
      controllers: [MarketEchoController, ExemptMarketReaderController],
    }));
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    logLines.length = 0;
  });

  describe('accepted', () => {
    it.each(TEST_MARKETS)('resolves %s and hands the minted context to @Market()', async (code) => {
      const response = await get('/test/market').set(HEADER, code).expect(200);

      expect(response.body).toEqual({ marketId: code, tenantId: 'mondapac', minted: true });
    });

    it.each(TEST_MARKETS)('makes a route market-scoped with no opt-in (%s)', async (code) => {
      await get('/test/market/plain').set(HEADER, code).expect(200);

      const response = await get('/test/market/plain').expect(400);
      expect(response.body).toEqual(missing);
    });

    it.each(TEST_MARKETS)(
      'returns a generated correlation id that passes parseCorrelationId (%s)',
      async (code) => {
        const accepted = await get('/test/market').set(HEADER, code).expect(200);
        const refused = await get('/test/market').set(HEADER, code.toLowerCase()).expect(400);

        for (const response of [accepted, refused]) {
          expect(parseCorrelationId(response.headers['x-correlation-id'] as string).ok).toBe(true);
        }
      },
    );

    it.each(TEST_MARKETS)(
      'never takes a UUID-shaped caller correlation id as the request id (%s)',
      async (code) => {
        const inbound = '0b5e3a8c-6c1e-4d7a-9f2b-1a2b3c4d5e6f';
        const response = await get('/test/market')
          .set(HEADER, code)
          .set('x-correlation-id', inbound)
          .expect(200);

        const generated = response.headers['x-correlation-id'] as string;
        expect(generated).not.toBe(inbound);
        expect(logLines.filter((line) => line.correlationId === inbound)).toEqual([]);
        const carrying = logLines.filter((line) => line.clientRequestId === inbound);
        expect(carrying).toHaveLength(1);
        expect(carrying[0]).toBe(completionLineOf(logLines, generated));
      },
    );
  });

  describe('refused with 400 and the code only', () => {
    it('answers market.header-missing when the header is absent', async () => {
      const response = await get('/test/market').expect(400);

      expect(response.body).toEqual(missing);
    });

    it.each(
      TEST_MARKETS.flatMap((code) => [
        code.toLowerCase(),
        `${code}-X`,
        `${code}TOOLONGX`,
        `leak-${code}-sentinel`,
        `${code};${code}`,
      ]),
    )('answers market.header-invalid to %p without echoing or logging it', async (value) => {
      const response = await get('/test/market').set(HEADER, value).expect(400);

      expect(response.body).toEqual(invalid);
      expectNowhere(value, response, logLines);
    });

    it('answers market.header-invalid to an empty header', async () => {
      const response = await get('/test/market').set(HEADER, '').expect(400);

      expect(response.body).toEqual(invalid);
    });

    it.each([
      [TEST_MARKETS[0], TEST_MARKETS[1]],
      [TEST_MARKETS[1], TEST_MARKETS[0]],
      [TEST_MARKETS[0], TEST_MARKETS[0]],
      [TEST_MARKETS[1], TEST_MARKETS[1]],
    ])('answers market.header-invalid to a repeated header (%s, %s)', async (first, second) => {
      // Two real header lines, sent with Node's own client; Node joins them on receipt.
      const response = await rawGet(app, '/test/market', { [HEADER]: [first, second] });

      expect(receivedCount(response, HEADER)).toBe(2);
      expect(response.status).toBe(400);
      expect(JSON.parse(response.text)).toEqual(invalid);
    });

    it('answers market.not-hosted to a well-formed market this stack does not host', async () => {
      const response = await get('/test/market').set(HEADER, NOT_HOSTED).expect(400);

      expect(response.body).toEqual(notHosted);
      expectNowhere(NOT_HOSTED, response, logLines);
    });

    it('logs a refusal once, as the completion line, with no header value', async () => {
      await get('/test/market').set(HEADER, NOT_HOSTED).expect(400);

      expect(logLines).toHaveLength(1);
      expect(logLines[0]).toMatchObject({
        msg: 'request completed',
        req: { method: 'GET', url: '/test/market' },
        res: { statusCode: 400 },
      });
    });
  });

  describe('exempt and unrouted paths', () => {
    it('serves /health without the header', async () => {
      await get('/health').expect(200);
    });

    it('serves /health/ready without the header (503 here: no database)', async () => {
      await get('/health/ready').expect(503);
    });

    it('answers an unknown route with 404, not with a market error', async () => {
      const response = await get('/no-such-route').expect(404);

      expect(response.body).not.toHaveProperty('code');
    });

    it.each(TEST_MARKETS)(
      '@Market() throws on an exempt controller instead of defaulting (%s)',
      async (code) => {
        const withHeader = await get('/test/exempt').set(HEADER, code).expect(500);
        const withoutHeader = await get('/test/exempt').expect(500);

        for (const response of [withHeader, withoutHeader]) {
          expect(response.body).toEqual({ statusCode: 500, message: 'Internal server error' });
        }
      },
    );
  });

  describe('composition root', () => {
    it('registers MarketContextGuard and RateLimitGuard, in order, in AppModule only', () => {
      expect(GLOBAL_GUARDS).toEqual([MarketContextGuard, RateLimitGuard]);

      const declared: { module: string; guard: unknown }[] = [];
      for (const moduleRef of app.get(ModulesContainer).values()) {
        for (const collection of [moduleRef.providers, moduleRef.injectables]) {
          for (const [token, wrapper] of collection) {
            if (typeof token === 'string' && token.startsWith(APP_GUARD)) {
              declared.push({ module: moduleRef.metatype.name, guard: wrapper.metatype });
            }
          }
        }
      }
      expect(declared).toEqual(GLOBAL_GUARDS.map((guard) => ({ module: AppModule.name, guard })));
    });

    it('runs exactly the guards of GLOBAL_GUARDS, in order (no useGlobalGuards anywhere)', () => {
      // The application's own list of global guards, after configureApp: what really runs.
      const running = (app as unknown as { config: ApplicationConfig }).config.getGlobalGuards();

      expect(running.map((guard) => guard.constructor)).toEqual([...GLOBAL_GUARDS]);
    });

    it('binds the real clock and id generator', () => {
      expect(app.get(CLOCK)).toBeInstanceOf(SystemClock);
      expect(app.get(ID_GENERATOR)).toBeInstanceOf(UuidV7IdGenerator);
    });

    it.each([
      [ClockModule, [CLOCK]],
      [IdsModule, [ID_GENERATOR]],
      [MarketContextModule, [MarketContextFactory]],
    ])('makes %p global and exports its token or factory only', (module, exported) => {
      expect(Reflect.getMetadata(GLOBAL_MODULE_METADATA, module)).toBe(true);
      expect(Reflect.getMetadata(MODULE_METADATA.EXPORTS, module)).toEqual(exported);
    });
  });

  describe('OpenAPI', () => {
    type Operation = { operationId?: string; parameters?: { name?: string; in?: string }[] };

    function operations(): [string, Operation][] {
      return Object.entries(buildOpenApiDocument(app).paths).flatMap(([path, item]) =>
        Object.entries(item as Record<string, Operation>).map(
          ([method, operation]) =>
            [`${method.toUpperCase()} ${path}`, operation] as [string, Operation],
        ),
      );
    }

    const marketHeader = (operation: Operation) =>
      operation.parameters?.find(
        (parameter) => parameter.in === 'header' && parameter.name === HEADER,
      );

    it('gives every operation a unique id', () => {
      const ids = operations().map(([, operation]) => operation.operationId);

      expect(ids).not.toContain(undefined);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it('documents x-market-id as required on market-scoped operations only', () => {
      const byName = new Map(operations());

      expect(marketHeader(byName.get('GET /health')!)).toBeUndefined();
      expect(marketHeader(byName.get('GET /health/ready')!)).toBeUndefined();
      expect(marketHeader(byName.get('GET /test/exempt')!)).toBeUndefined();
      for (const name of [
        'GET /test/market',
        'GET /test/market/plain',
        'SEARCH /test/market/search',
      ]) {
        expect(marketHeader(byName.get(name)!)).toMatchObject({ in: 'header', required: true });
      }
    });
  });
});
