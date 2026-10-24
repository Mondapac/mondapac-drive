import { Controller, Get, HttpCode, Post } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { RateLimit } from '../src/platform/rate-limit/rate-limit.decorator';
import { createTestApp } from './support/test-app';

// The generic per-origin rate limiter (identity design 6.8 and 12.2; ADR-0015 decision 3).
// Limits come from the Market fixtures: AU 20 / 300 a minute, ZZ 10 / 200 a minute.

/** How often each test route's handler ran: proves a throttled request reaches no code. */
const reached = { anonymous: 0, plain: 0 };

/** Test-only routes, one per limit class. */
@Controller('test/limited')
class LimitedController {
  @Post('anonymous')
  @HttpCode(200)
  @RateLimit('anonymous-identity')
  anonymous(): { ok: true } {
    reached.anonymous += 1;
    return { ok: true };
  }

  @Get('plain')
  plain(): { ok: true } {
    reached.plain += 1;
    return { ok: true };
  }
}

/** The one answer to a throttled request: our code, never the library's text. */
const THROTTLED = {
  statusCode: 429,
  code: 'request.throttled',
  details: { retryAfterSeconds: expect.any(Number) as number },
};

describe('generic per-origin rate limiter (integration)', () => {
  let app: NestExpressApplication;
  const anonymous = (market: string, headers: Record<string, string> = {}) =>
    request(app.getHttpServer())
      .post('/test/limited/anonymous')
      .set({ 'x-market-id': market, ...headers })
      .send({});
  const plain = (market: string) =>
    request(app.getHttpServer()).get('/test/limited/plain').set('x-market-id', market);

  /** Sends `count` requests one after the other and answers their statuses. */
  async function statuses(count: number, send: () => request.Test): Promise<number[]> {
    const answers: number[] = [];
    for (let index = 0; index < count; index += 1) answers.push((await send()).status);
    return answers;
  }

  // A fresh application per test: the counters live in the guard, in the process's memory.
  beforeEach(async () => {
    reached.anonymous = 0;
    reached.plain = 0;
    ({ app } = await createTestApp({ controllers: [LimitedController] }));
  });

  afterEach(async () => {
    await app.close();
  });

  it('answers the Market limit of an anonymous identity route, then 429 with our code', async () => {
    expect(await statuses(20, () => anonymous('AU'))).toEqual(Array<number>(20).fill(200));

    const refused = await anonymous('AU');

    expect(refused.status).toBe(429);
    expect(refused.body).toEqual(THROTTLED);
    const retryAfter = (refused.body as { details: { retryAfterSeconds: number } }).details
      .retryAfterSeconds;
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(60);
    expect(refused.headers['retry-after']).toBe(String(retryAfter));
    // The security headers of slice 0 item 6 are on the 429 too.
    expect(refused.headers['cache-control']).toBe('no-store');
    expect(refused.text).not.toMatch(/too many|rate.?limit|points/i);
  });

  it('runs before the controller: a throttled request never reaches the handler', async () => {
    await statuses(25, () => anonymous('AU'));

    expect(reached.anonymous).toBe(20);
  });

  it('keys on the socket address: forged forwarding headers neither reset nor split it', async () => {
    let forged = 0;
    const forging = () =>
      anonymous('AU', {
        'x-forwarded-for': `198.51.100.${(forged += 1)}`,
        forwarded: `for=203.0.113.${forged}`,
        'x-real-ip': `192.0.2.${forged}`,
      });

    const answers = await statuses(21, forging);

    expect(answers.slice(0, 20)).toEqual(Array<number>(20).fill(200));
    expect(answers[20]).toBe(429);
    expect(reached.anonymous).toBe(20);
  });

  it('takes the limit from the request Market, on one counter per origin for every Market', async () => {
    // ZZ allows 10 a minute on anonymous identity routes.
    expect(await statuses(10, () => anonymous('ZZ'))).toEqual(Array<number>(10).fill(200));
    expect((await anonymous('ZZ')).status).toBe(429);

    // The same origin's counter (now 11) is still under AU's 20: not split by Market (PF I11).
    expect(await statuses(9, () => anonymous('AU'))).toEqual(Array<number>(9).fill(200));
    expect((await anonymous('AU')).status).toBe(429);
  });

  it('keeps one counter per limit class: other routes have their own, larger limit', async () => {
    await statuses(21, () => anonymous('AU'));

    // AU's default is 300 a minute; the anonymous class does not use it up.
    expect(await statuses(300, () => plain('AU'))).toEqual(Array<number>(300).fill(200));
    const refused = await plain('AU');

    expect(refused.status).toBe(429);
    expect(refused.body).toEqual(THROTTLED);
    expect(reached.plain).toBe(300);
  });

  it('runs after the Market guard: a request without a valid Market is refused first', async () => {
    const missing = await request(app.getHttpServer()).post('/test/limited/anonymous').send({});
    const unknown = await anonymous('NZ');

    expect(missing.status).toBe(400);
    expect(missing.body).toEqual({ statusCode: 400, code: 'market.header-missing' });
    expect(unknown.body).toEqual({ statusCode: 400, code: 'market.not-hosted' });
    // Those requests counted nothing: the whole limit is still there.
    expect(await statuses(20, () => anonymous('AU'))).toEqual(Array<number>(20).fill(200));
  });

  it('leaves the exempt health check alone', async () => {
    await statuses(301, () => plain('AU'));

    expect((await request(app.getHttpServer()).get('/health')).status).not.toBe(429);
  });
});
