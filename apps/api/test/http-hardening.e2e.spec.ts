import { gzipSync } from 'node:zlib';
import { Body, Controller, Get, HttpCode, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { MarketEchoController } from './support/market-test.controllers';
import { createTestApp, type LogLine } from './support/test-app';

const SECRET = 'hunter2-hardening-secret';
const ONE_KIB = 1024;

/**
 * Test-only: echoes the parsed body. Market-scoped: an unsafe route on a market-exempt controller
 * fails the start-up check (identity design 6.4).
 */
@Controller('test/hardening-echo')
class EchoController {
  @Post()
  @HttpCode(200)
  echo(@Body() body: unknown): unknown {
    return body === undefined ? { parsed: false } : body;
  }

  @Get('ip')
  ip(@Req() req: Request): { ip: string | undefined } {
    return { ip: req.ip };
  }
}

/** The headers every answer carries (slice 0 item 6, Hassan). */
const SECURITY_HEADERS = {
  'cache-control': 'no-store',
  'content-security-policy': "default-src 'none';frame-ancestors 'none'",
  'strict-transport-security': 'max-age=63072000; includeSubDomains',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
};

function expectSecurityHeaders(response: request.Response): void {
  expect(response.headers).toMatchObject(SECURITY_HEADERS);
  expect(response.headers).not.toHaveProperty('x-powered-by');
  expect(response.headers).not.toHaveProperty('access-control-allow-origin');
}

// Its own file: one application per Jest module registry (see test/support/test-app.ts).
describe('HTTP hardening (integration, slice 0 item 6)', () => {
  let app: NestExpressApplication;
  let logLines: LogLine[];
  const post = (body: string, type = 'application/json') =>
    request(app.getHttpServer())
      .post('/test/hardening-echo')
      .set('x-market-id', 'AU')
      .set('content-type', type)
      .send(body);

  beforeAll(async () => {
    ({ app, logLines } = await createTestApp({
      controllers: [EchoController, MarketEchoController],
    }));
  });

  afterAll(async () => {
    await app.close();
    expect(JSON.stringify(logLines)).not.toContain(SECRET);
  });

  describe('security headers', () => {
    it.each([
      ['/health', 200],
      ['/an-unknown-route', 404],
      ['/test/market', 400], // the market guard's 400 (platform-foundations 5.1)
    ])('are on GET %s (%i)', async (path, status) => {
      expectSecurityHeaders(await request(app.getHttpServer()).get(path).expect(status));
    });

    it('are on an answer the body parser refused', async () => {
      expectSecurityHeaders(await post('{').expect(400));
    });

    it('include no CORS headers, even for a preflight', async () => {
      const response = await request(app.getHttpServer())
        .options('/health')
        .set('origin', 'https://elsewhere.example')
        .set('access-control-request-method', 'POST');

      expect(response.headers).not.toHaveProperty('access-control-allow-origin');
      expect(response.headers).not.toHaveProperty('access-control-allow-methods');
    });
  });

  describe('body parsing', () => {
    it('parses a JSON object', async () => {
      const response = await post(JSON.stringify({ field: 'value' })).expect(200);

      expect(response.body).toEqual({ field: 'value' });
    });

    it('accepts a body of 64 KiB and refuses one byte more with 413', async () => {
      const exactly = (size: number) => JSON.stringify({ f: 'x'.repeat(size - 8) });
      expect(exactly(64 * ONE_KIB)).toHaveLength(64 * ONE_KIB);

      await post(exactly(64 * ONE_KIB)).expect(200);
      const response = await post(exactly(64 * ONE_KIB + 1)).expect(413);
      expect(response.body).toEqual({ statusCode: 413, code: 'request.body-too-large' });
      expect(response.headers['x-correlation-id']).toEqual(expect.any(String));
    });

    it('refuses a top-level JSON primitive (strict)', async () => {
      const response = await post(`"${SECRET}"`).expect(400);

      expect(response.body).toEqual({ statusCode: 400, code: 'request.body-malformed' });
    });

    it('answers malformed JSON with a fixed code and never echoes the body', async () => {
      const response = await post(`{"password":"${SECRET}"`).expect(400);

      expect(response.body).toEqual({ statusCode: 400, code: 'request.body-malformed' });
      expect(response.text).not.toContain(SECRET);
    });

    it('answers an unsupported charset with 415 and a fixed code', async () => {
      const response = await post('{}', 'application/json; charset=x-unknown').expect(415);

      expect(response.body).toEqual({ statusCode: 415, code: 'request.body-unsupported' });
    });

    it.each([
      ['gzip', gzipSync(JSON.stringify({ password: SECRET }))],
      ['gzip', Buffer.from(`not gzip ${SECRET}`)],
      ['deflate', Buffer.from(`not deflate ${SECRET}`)],
      ['br', Buffer.from(`not brotli ${SECRET}`)],
    ])('refuses a %s-encoded body with 415 and never decompresses it', async (encoding, body) => {
      const response = await request(app.getHttpServer())
        .post('/test/hardening-echo')
        .set('x-market-id', 'AU')
        .set('content-type', 'application/json')
        .set('content-encoding', encoding)
        .send(body)
        .expect(415);

      expect(response.body).toEqual({ statusCode: 415, code: 'request.body-unsupported' });
      expect(response.text).not.toMatch(/header check|decompress|zlib/i);
      expect(response.text).not.toContain(SECRET);
    });

    it('does not parse a form body', async () => {
      const response = await post(`password=${SECRET}`, 'application/x-www-form-urlencoded').expect(
        200,
      );

      expect(response.body).toEqual({ parsed: false });
    });
  });

  it('trusts no proxy: X-Forwarded-For does not change the client address', async () => {
    const express = app.getHttpAdapter().getInstance() as { get(name: string): unknown };
    expect(express.get('trust proxy')).toBe(false);

    const response = await request(app.getHttpServer())
      .get('/test/hardening-echo/ip')
      .set('x-market-id', 'AU')
      .set('x-forwarded-for', '1.2.3.4')
      .expect(200);

    const { ip } = response.body as { ip: unknown };
    expect(typeof ip).toBe('string');
    expect(ip).not.toBe('1.2.3.4');
  });
});
