import { Controller, Get, HttpCode, Post } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Client } from 'pg';
import { SystemClock } from '../../src/platform/clock/system-clock';
import request from 'supertest';
import { RoutePopulation } from '../../src/platform/call-context/route-population.decorator';
import { PostgresRateLimitCounters } from '../../src/platform/persistence/postgres-rate-limit-counters';
import { RateLimit } from '../../src/platform/rate-limit/rate-limit.decorator';
import { createTestApp } from '../support/test-app';
import { createPersistence } from './persistence-support';
import { testDatabaseUrl } from './test-database';

// The generic per-origin rate limiter on its PostgreSQL store (identity design 6.8 and 13; buyer
// scale-out item (a)): two applications on one database stand for two API instances, and must
// see one count per limit class and origin. Limits come from the Market fixtures: AU 20 / 300
// a minute, ZZ 10 / 200 a minute. This is the only suite that counts in the table, so clearing
// it between tests disturbs no other suite.

@RoutePopulation('courier')
@Controller('test/limited')
class LimitedController {
  @Post('anonymous')
  @HttpCode(200)
  @RateLimit('anonymous-identity')
  anonymous(): { ok: true } {
    return { ok: true };
  }

  @Get('plain')
  plain(): { ok: true } {
    return { ok: true };
  }
}

const ANONYMOUS_LIMIT: Readonly<Record<string, number>> = { AU: 20, ZZ: 10 };

describe('rate-limit counters shared across API instances (database)', () => {
  let first: NestExpressApplication;
  let second: NestExpressApplication;
  let sql: Client;

  const anonymous = (app: NestExpressApplication, market: string) =>
    request(app.getHttpServer())
      .post('/test/limited/anonymous')
      .set('x-market-id', market)
      .send({});
  const plain = (app: NestExpressApplication, market: string) =>
    request(app.getHttpServer()).get('/test/limited/plain').set('x-market-id', market);

  async function statuses(count: number, send: () => request.Test): Promise<number[]> {
    const answers: number[] = [];
    for (let index = 0; index < count; index += 1) answers.push((await send()).status);
    return answers;
  }

  beforeAll(async () => {
    const options = {
      env: { DATABASE_URL: testDatabaseUrl() },
      controllers: [LimitedController],
      rateLimitStore: 'postgres',
    } as const;
    ({ app: first } = await createTestApp(options));
    ({ app: second } = await createTestApp(options));
    // Listening up front, so the concurrent requests share one server instead of each opening one.
    await first.listen(0, '127.0.0.1');
    await second.listen(0, '127.0.0.1');
    sql = new Client({ connectionString: testDatabaseUrl() });
    await sql.connect();
  });

  beforeEach(async () => {
    await sql.query('DELETE FROM platform.rate_limit_counters');
  });

  afterAll(async () => {
    await sql.end();
    await first.close();
    await second.close();
  });

  describe.each(Object.entries(ANONYMOUS_LIMIT))('in market %s', (market, limit) => {
    it('counts the requests of both instances in one window', async () => {
      const onFirst = Math.ceil(limit / 2);

      expect(await statuses(onFirst, () => anonymous(first, market))).toEqual(
        Array<number>(onFirst).fill(200),
      );
      expect(await statuses(limit - onFirst, () => anonymous(second, market))).toEqual(
        Array<number>(limit - onFirst).fill(200),
      );

      const refusedOnSecond = await anonymous(second, market);
      const refusedOnFirst = await anonymous(first, market);

      for (const refused of [refusedOnSecond, refusedOnFirst]) {
        expect(refused.status).toBe(429);
        expect(refused.body).toEqual({
          statusCode: 429,
          code: 'request.throttled',
          details: { retryAfterSeconds: expect.any(Number) as number },
        });
        expect(refused.headers['retry-after']).toBe(
          String(
            (refused.body as { details: { retryAfterSeconds: number } }).details.retryAfterSeconds,
          ),
        );
      }
    });

    it('admits exactly the limit when both instances are hit at once', async () => {
      const sent = limit + 10;
      const answers = await Promise.all(
        Array.from({ length: sent }, (_, index) =>
          anonymous(index % 2 === 0 ? first : second, market).then((response) => response.status),
        ),
      );

      expect(answers.filter((status) => status === 200)).toHaveLength(limit);
      expect(answers.filter((status) => status === 429)).toHaveLength(10);
    });
  });

  it('keeps one row per limit class and origin, keyed by a hash and never the address', async () => {
    await statuses(3, () => anonymous(first, 'AU'));
    await statuses(2, () => plain(second, 'ZZ'));

    const { rows } = await sql.query<{ key: string; points: number }>(
      'SELECT key, points FROM platform.rate_limit_counters ORDER BY key',
    );

    expect(rows).toHaveLength(2);
    expect(rows[0]!.key).toMatch(/^anonymous-identity:[0-9a-f]{64}$/);
    expect(rows[0]!.points).toBe(3);
    expect(rows[1]!.key).toMatch(/^default:[0-9a-f]{64}$/);
    expect(rows[1]!.points).toBe(2);
    // The same origin hashes to the same key in both instances and both classes.
    expect(rows[0]!.key.split(':')[1]).toBe(rows[1]!.key.split(':')[1]);
    expect(rows.map((row) => row.key).join()).not.toMatch(/127\.0\.0\.1|::1|ffff/);
  });

  it('refuses a key that is not a hashed origin of a known class (CHECK)', async () => {
    await expect(
      sql.query("INSERT INTO platform.rate_limit_counters VALUES ('default:127.0.0.1', 1, 1)"),
    ).rejects.toMatchObject({ code: '23514', constraint: 'rate_limit_counters_key_check' });
  });
});

describe('rate-limit counters purge (database)', () => {
  it('deletes only the windows that ended before the cut-off', async () => {
    const persistence = createPersistence();
    const counters = new PostgresRateLimitCounters(persistence.root, new SystemClock());
    const sql = new Client({ connectionString: testDatabaseUrl() });
    await sql.connect();
    try {
      await sql.query('DELETE FROM platform.rate_limit_counters');
      const ended = `default:${'a'.repeat(64)}`;
      const running = `default:${'b'.repeat(64)}`;
      await sql.query(
        'INSERT INTO platform.rate_limit_counters VALUES ($1, 4, 1000), ($2, 1, 3000)',
        [ended, running],
      );

      expect(await counters.purgeEnded(2000)).toBe(1);

      const { rows } = await sql.query<{ key: string }>(
        'SELECT key FROM platform.rate_limit_counters',
      );
      expect(rows).toEqual([{ key: running }]);
    } finally {
      counters.onModuleDestroy();
      await sql.end();
      await persistence.close();
    }
  });
});
