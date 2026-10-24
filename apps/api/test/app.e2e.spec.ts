import { Writable } from 'node:stream';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { Logger } from 'nestjs-pino';
import { parseCorrelationId } from '@mondapac-drive/shared-kernel';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { APP_OPTIONS, configureApp } from '../src/configure-app';
import { buildOpenApiDocument } from '../src/openapi';
import {
  MarketNotHostedError,
  MarketRegistry,
} from '../src/platform/market-config/market-registry';
import { completionLineOf, rawGet, receivedCount } from './support/test-app';
import { testAppConfig, testMarketId, TEST_MARKETS } from './support/test-config';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

interface LogLine {
  correlationId?: string;
  clientRequestId?: string;
  msg?: string;
  req?: Record<string, unknown>;
  res?: Record<string, unknown>;
}

// One application per file: nestjs-pino keeps one logger per Jest module registry, so a
// second application here would leave these log assertions without lines. The API-docs
// case lives in api-docs.e2e.spec.ts.
describe('API skeleton (integration)', () => {
  let app: NestExpressApplication;
  let logLines: LogLine[];

  beforeAll(async () => {
    logLines = [];
    const logDestination = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        for (const line of chunk.toString().split('\n').filter(Boolean)) {
          logLines.push(JSON.parse(line) as LogLine);
        }
        callback();
      },
    });

    const moduleRef = await Test.createTestingModule({
      imports: [
        AppModule.register({
          config: testAppConfig(),
          logDestination,
        }),
      ],
    }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>(APP_OPTIONS);
    app.useLogger(app.get(Logger));
    configureApp(app);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    logLines.length = 0;
  });

  it('GET /health reports liveness', async () => {
    const response = await request(app.getHttpServer()).get('/health').expect(200);

    expect(response.body).toEqual({ status: 'ok' });
  });

  it('generates a correlation id, returns it and logs it', async () => {
    const response = await request(app.getHttpServer()).get('/health').expect(200);

    const correlationId = response.headers['x-correlation-id'];
    expect(correlationId).toMatch(UUID);
    expect(logLines.find((line) => line.msg === 'request completed')).toMatchObject({
      correlationId,
      req: { method: 'GET', url: '/health' },
      res: { statusCode: 200 },
    });
  });

  it('generates a correlation id that passes the kernel rule', async () => {
    const response = await request(app.getHttpServer()).get('/health').expect(200);

    expect(parseCorrelationId(response.headers['x-correlation-id'] as string).ok).toBe(true);
  });

  // ADR-0020 decision 8 (C3): a caller's id is never the id of the request.
  it("never takes the caller's correlation id; logs a well-formed one once as clientRequestId", async () => {
    const response = await request(app.getHttpServer())
      .get('/health')
      .set('x-correlation-id', 'caller-supplied-0001')
      .expect(200);

    expect(response.headers['x-correlation-id']).toMatch(UUID);
    expect(response.headers['x-correlation-id']).not.toBe('caller-supplied-0001');
    expect(logLines.map((line) => line.correlationId)).not.toContain('caller-supplied-0001');
    const mentions = logLines.filter((line) => JSON.stringify(line).includes('caller-supplied'));
    expect(mentions).toEqual([
      expect.objectContaining({
        msg: 'request completed',
        correlationId: response.headers['x-correlation-id'],
        clientRequestId: 'caller-supplied-0001',
      }),
    ]);
  });

  it('logs clientRequestId once also when the request ends in an error', async () => {
    // The database is unreachable here, so readiness fails with 503 and logs an error.
    await request(app.getHttpServer())
      .get('/health/ready')
      .set('x-correlation-id', 'caller-supplied-0002')
      .expect(503);

    const mentions = logLines.filter((line) => JSON.stringify(line).includes('caller-supplied'));
    expect(mentions).toEqual([
      expect.objectContaining({ msg: 'request errored', clientRequestId: 'caller-supplied-0002' }),
    ]);
    // Other lines of the same request carry the generated id only.
    expect(
      logLines.find((line) => line.msg === 'readiness check failed: database unreachable'),
    ).not.toHaveProperty('clientRequestId');
  });

  it('drops a malformed correlation id: it is logged nowhere', async () => {
    const response = await request(app.getHttpServer())
      .get('/health')
      .set('x-correlation-id', 'bad id {with} spaces')
      .expect(200);

    expect(response.headers['x-correlation-id']).toMatch(UUID);
    completionLineOf(logLines, response.headers['x-correlation-id'] as string);
    expect(JSON.stringify(logLines)).not.toContain('bad id');
    expect(logLines.some((line) => 'clientRequestId' in line)).toBe(false);
  });

  it('drops a repeated correlation id header (Node joins it into one malformed value)', async () => {
    // Two real header lines, sent with Node's own client.
    const response = await rawGet(app, '/health', {
      'x-correlation-id': ['first-id-0001', 'second-id-0002'],
    });

    expect(receivedCount(response, 'x-correlation-id')).toBe(2);
    expect(response.status).toBe(200);
    const completion = completionLineOf(logLines, response.headers['x-correlation-id'] as string);
    expect(completion).not.toHaveProperty('clientRequestId');
    expect(JSON.stringify(logLines)).not.toContain('first-id-0001');
    expect(JSON.stringify(logLines)).not.toContain('second-id-0002');
  });

  it('does not log request headers', async () => {
    const response = await request(app.getHttpServer())
      .get('/health')
      .set('authorization', 'Bearer secret-token-value')
      .expect(200);

    completionLineOf(logLines, response.headers['x-correlation-id'] as string);
    expect(JSON.stringify(logLines)).not.toContain('secret-token-value');
  });

  it('does not log the query string', async () => {
    const response = await request(app.getHttpServer())
      .get('/health?token=secret-query-value')
      .expect(200);

    expect(completionLineOf(logLines, response.headers['x-correlation-id'] as string).req).toEqual({
      method: 'GET',
      url: '/health',
    });
    expect(JSON.stringify(logLines)).not.toContain('secret-query-value');
  });

  it('answers unknown routes with 404 and still sets a correlation id', async () => {
    const response = await request(app.getHttpServer()).get('/no-such-route').expect(404);

    expect(response.headers['x-correlation-id']).toMatch(UUID);
  });

  it('GET /health/ready answers 503 without leaking details when the database is down', async () => {
    const response = await request(app.getHttpServer()).get('/health/ready').expect(503);

    expect(response.body).toMatchObject({ statusCode: 503, message: 'database unavailable' });
    expect(JSON.stringify(response.body)).not.toContain('unused');
  });

  it('does not advertise the framework', async () => {
    const response = await request(app.getHttpServer()).get('/health').expect(200);

    expect(response.headers).not.toHaveProperty('x-powered-by');
  });

  it('does not serve API docs unless they are enabled', async () => {
    await request(app.getHttpServer()).get('/docs').expect(404);
    await request(app.getHttpServer()).get('/docs-json').expect(404);
  });

  it('hosts exactly the configured markets and rejects any other', () => {
    const registry = app.get(MarketRegistry);

    expect(registry.hostedMarketIds()).toEqual([...TEST_MARKETS]);
    expect(() => registry.get(testMarketId('NZ'))).toThrow(MarketNotHostedError);
  });

  it('documents the health endpoints in OpenAPI', () => {
    const document = buildOpenApiDocument(app);

    expect(document.paths['/health']?.get?.responses).toHaveProperty('200');
    expect(document.paths['/health/ready']?.get?.responses).toHaveProperty('200');
    expect(document.paths['/health/ready']?.get?.responses).toHaveProperty('503');
  });
});
