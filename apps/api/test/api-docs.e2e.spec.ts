import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { MarketEchoController } from './support/market-test.controllers';
import { createTestApp } from './support/test-app';

// Its own file: one application per Jest module registry (see test/support/test-app.ts).
describe('API docs (integration)', () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    ({ app } = await createTestApp({
      env: { API_DOCS_ENABLED: 'true', LOG_LEVEL: 'silent' },
      controllers: [MarketEchoController],
    }));
  });

  afterAll(async () => {
    await app.close();
  });

  it('serves Swagger UI and the document when API_DOCS_ENABLED is true, without x-market-id', async () => {
    await request(app.getHttpServer()).get('/docs').expect(200);
    const response = await request(app.getHttpServer()).get('/docs-json').expect(200);

    expect(response.body).toHaveProperty(['paths', '/health/ready']);
  });

  it('relaxes the CSP for the Swagger UI page only (slice 0 item 6)', async () => {
    const page = await request(app.getHttpServer()).get('/docs').expect(200);
    const json = await request(app.getHttpServer()).get('/docs-json').expect(200);

    expect(page.headers['content-security-policy']).toBe(
      "default-src 'none';script-src 'self';style-src 'self' 'unsafe-inline';img-src 'self' data:;connect-src 'self';frame-ancestors 'none'",
    );
    expect(json.headers['content-security-policy']).toBe(
      "default-src 'none';frame-ancestors 'none'",
    );
    expect(page.headers['cache-control']).toBe('no-store');
  });

  it('gives the Swagger UI assets under /docs/ the same relaxed CSP', async () => {
    const asset = await request(app.getHttpServer()).get('/docs/swagger-ui-init.js').expect(200);

    expect(asset.headers['content-security-policy']).toContain("script-src 'self'");
  });

  it('documents x-market-id on market-scoped operations and not on /health', async () => {
    const response = await request(app.getHttpServer()).get('/docs-json').expect(200);

    const document = response.body as {
      paths: Record<string, { get: { parameters?: { name: string; in: string }[] } }>;
    };
    expect(document.paths['/test/market']?.get.parameters).toContainEqual(
      expect.objectContaining({ name: 'x-market-id', in: 'header', required: true }),
    );
    expect(document.paths['/health']?.get.parameters ?? []).not.toContainEqual(
      expect.objectContaining({ name: 'x-market-id' }),
    );
  });

  it('documents the optional x-client-address of ADR-0037 next to x-market-id, not on /health', async () => {
    const response = await request(app.getHttpServer()).get('/docs-json').expect(200);

    const document = response.body as {
      paths: Record<string, { get: { parameters?: { name: string; in: string }[] } }>;
    };
    expect(document.paths['/test/market']?.get.parameters).toContainEqual(
      expect.objectContaining({
        name: 'x-client-address',
        in: 'header',
        required: false,
        description: expect.stringContaining('client-address.untrusted') as unknown,
      }),
    );
    expect(document.paths['/health']?.get.parameters ?? []).not.toContainEqual(
      expect.objectContaining({ name: 'x-client-address' }),
    );
  });
});
