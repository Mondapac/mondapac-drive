import { createHmac } from 'node:crypto';
import { Controller, HttpCode, Post } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Temporal } from '@mondapac-drive/shared-kernel';
import type { Id } from '@mondapac-drive/shared-kernel';
import request from 'supertest';
import type { AccountState } from '../src/modules/identity/domain/account';
import { RoutePopulation } from '../src/platform/call-context/route-population.decorator';
import { RateLimit } from '../src/platform/rate-limit/rate-limit.decorator';
import { fakeHashOf, IdentityFakes } from './support/identity-fakes';
import { createTestApp, type LogLine } from './support/test-app';
import { TEST_MARKETS } from './support/test-config';

// ADR-0037 end to end: the real middleware, guards, controllers and use cases, with identity's
// database ports as in-memory fakes. The test client connects from 127.0.0.1, which these
// suites configure as the one BFF network, so every request below plays a BFF relaying a
// browser. nestjs-pino captures the log lines of a file's first application only, so the
// logging test comes first.

const KEY = Buffer.alloc(32, 0x5a).toString('base64');
const BFF_ENV = {
  TRUSTED_BFF_CIDRS: '127.0.0.1/32,::1/128',
  CLIENT_ADDRESS_KEYS: `panel:127.0.0.1/32,::1/128:${KEY}`,
};
const PASSWORD = 'correct horse battery staple';
const EMAIL = 'Courier@Example.com';
const CLIENT_A = '203.0.113.7';
const CLIENT_B = '203.0.113.8';
const fakes = new IdentityFakes();

/** Market numbers of config/markets/AU.json and test/fixtures/markets/ZZ.json. */
const NUMBERS: Record<string, { anonymousPerMinute: number; accountOriginLimit: number }> = {
  AU: { anonymousPerMinute: 20, accountOriginLimit: 5 },
  ZZ: { anonymousPerMinute: 10, accountOriginLimit: 4 },
};

/** The BFF's proof, signed here with Node's HMAC as the ADR specifies. */
function proof(address: string, market: string, options: { t?: number; key?: string } = {}) {
  const t = String(options.t ?? Math.floor(Date.now() / 1000));
  const s = createHmac('sha256', Buffer.from(options.key ?? KEY, 'base64'))
    .update(`v1\npanel\n${t}\n${address}\n${market}`, 'utf8')
    .digest('base64url');
  return `v1;k=panel;t=${t};a=${address};s=${s}`;
}

/** As the BFF relays a browser at `address`: the Market and the proof. */
const viaBff = (market: string, address: string) => ({
  'x-market-id': market,
  'x-client-address': proof(address, market),
});

function seed(code: string, overrides: Partial<AccountState> = {}): void {
  const now = Temporal.Instant.from('2026-10-01T00:00:00Z');
  fakes.seedAccount({
    id: `0199${code === 'AU' ? 'aaaa' : 'bbbb'}-0000-7000-8000-000000000037` as Id<'Account'>,
    marketId: code as AccountState['marketId'],
    population: 'courier',
    email: { typed: EMAIL, normalized: EMAIL.toLowerCase() },
    displayName: 'Courier',
    status: 'active',
    emailVerifiedAt: now,
    signedUpAt: now,
    createdAt: now,
    version: 1,
    credential: { passwordHash: fakeHashOf(PASSWORD), changedAt: now },
    ...overrides,
  });
}

/** A test-only route of the anonymous identity limit class. */
@RoutePopulation('courier')
@Controller('test/client-address')
class LimitedController {
  @Post('anonymous')
  @HttpCode(200)
  @RateLimit('anonymous-identity')
  anonymous(): { ok: true } {
    return { ok: true };
  }
}

const UNTRUSTED = { statusCode: 400, code: 'client-address.untrusted' };

describe('the client address behind a BFF (ADR-0037, integration)', () => {
  let app: NestExpressApplication;
  let logLines: LogLine[];
  const http = () => request(app.getHttpServer());
  const signIn = (headers: Record<string, string>, password = PASSWORD) =>
    http().post('/identity/courier/sign-in').set(headers).send({ email: EMAIL, password });

  async function boot(env: Record<string, string> = BFF_ENV) {
    ({ app, logLines } = await createTestApp({
      env: { LOG_LEVEL: 'info', ...env },
      controllers: [LimitedController],
      override: (builder) => fakes.override(builder),
    }));
  }

  beforeEach(() => fakes.reset());
  afterEach(async () => {
    await app.close();
  });

  it('logs a refusal by reason, keyId and correlation id; never the address, signature, header or key', async () => {
    await boot();
    seed('AU');
    const signedIn = await signIn(viaBff('AU', CLIENT_A));
    const header = proof(CLIENT_B, 'AU');
    const refusals = [
      await signIn({ 'x-market-id': 'AU' }),
      await signIn({ 'x-market-id': 'ZZ', 'x-client-address': header }),
      await signIn({
        'x-market-id': 'AU',
        'x-client-address': proof(CLIENT_B, 'AU', { t: Math.floor(Date.now() / 1000) - 600 }),
      }),
    ];

    expect(signedIn.status).toBe(200);
    expect(refusals.map((r) => [r.status, r.body as unknown])).toEqual(
      Array<unknown>(3).fill([400, UNTRUSTED]),
    );
    const lines = logLines.filter((line) => line.msg === 'client-address.untrusted');
    expect(lines.map((line) => [line.reason, line.keyId, line.correlationId])).toEqual([
      ['missing', null, refusals[0]!.headers['x-correlation-id']],
      ['signature-invalid', 'panel', refusals[1]!.headers['x-correlation-id']],
      ['stale', 'panel', refusals[2]!.headers['x-correlation-id']],
    ]);
    const all = JSON.stringify(logLines);
    for (const secret of [CLIENT_A, CLIENT_B, header, header.split(';s=')[1]!, KEY]) {
      expect(all).not.toContain(secret);
    }
  });

  describe.each(TEST_MARKETS)('in market %s', (code) => {
    const other = code === 'AU' ? 'ZZ' : 'AU';

    it('gives two clients behind one BFF socket separate generic rate-limit buckets', async () => {
      await boot();
      const { anonymousPerMinute } = NUMBERS[code]!;
      const send = (address: string) =>
        http().post('/test/client-address/anonymous').set(viaBff(code, address)).send({});

      for (let n = 0; n < anonymousPerMinute; n += 1)
        expect((await send(CLIENT_A)).status).toBe(200);
      expect((await send(CLIENT_A)).status).toBe(429);

      expect((await send(CLIENT_B)).status).toBe(200);
    });

    it('gives them separate sign-in.origin and per-account-origin buckets', async () => {
      await boot();
      seed(code);
      const { accountOriginLimit } = NUMBERS[code]!;

      for (let n = 0; n < accountOriginLimit; n += 1) {
        expect((await signIn(viaBff(code, CLIENT_A), 'wrong password')).status).toBe(401);
      }
      expect((await signIn(viaBff(code, CLIENT_A))).status).toBe(429);
      const fromB = await signIn(viaBff(code, CLIENT_B));

      expect(fromB.status).toBe(200);
      const origins = [...fakes.throttles.keys()].filter((key) =>
        key.startsWith(`${code}|sign-in.origin|`),
      );
      expect(origins).toHaveLength(2);
    });

    it('gives them separate mail.origin buckets', async () => {
      await boot();
      const resetEmail = (address: string, email: string) =>
        http()
          .post('/identity/courier/password-reset-email')
          .set(viaBff(code, address))
          .send({ email });

      expect((await resetEmail(CLIENT_A, 'first@example.com')).status).toBe(202);
      expect((await resetEmail(CLIENT_B, 'second@example.com')).status).toBe(202);

      const origins = [...fakes.throttles.entries()].filter(([key]) =>
        key.startsWith(`${code}|mail.origin|`),
      );
      expect(origins.map(([, row]) => row.attempts)).toEqual([1, 1]);
    });

    it.each([
      [CLIENT_A, CLIENT_A],
      ['2001:DB8:1:2:0:0:0:7', '2001:db8:1:2:0:0:0:7'],
      ['::ffff:198.51.100.9', '198.51.100.9'],
    ])('stores the proven address %s on the sign-in record as %s', async (sent, stored) => {
      await boot();
      seed(code);

      const response = await signIn(viaBff(code, sent));

      expect(response.status).toBe(200);
      expect(fakes.records.map((record) => [record.marketId, record.address])).toEqual([
        [code, stored],
      ]);
    });

    it('still ignores X-Forwarded-For and Forwarded', async () => {
      await boot();
      seed(code);

      const response = await signIn({
        ...viaBff(code, CLIENT_A),
        'x-forwarded-for': '198.51.100.77',
        forwarded: 'for=198.51.100.78',
        'x-real-ip': '198.51.100.79',
      });

      expect(response.status).toBe(200);
      expect(fakes.records.map((record) => record.address)).toEqual([CLIENT_A]);
    });

    it(`refuses a proof made for ${other} and reaches no identity code`, async () => {
      await boot();
      seed(code);

      const response = await signIn({
        'x-market-id': code,
        'x-client-address': proof(CLIENT_A, other),
      });

      expect(response.status).toBe(400);
      expect(response.body).toEqual(UNTRUSTED);
      expect(fakes.records).toEqual([]);
      expect(fakes.throttles.size).toBe(0);
    });

    it('refuses a request from the BFF network without a proof, never using the socket', async () => {
      await boot();
      seed(code);

      const response = await signIn({ 'x-market-id': code });

      expect(response.status).toBe(400);
      expect(response.body).toEqual(UNTRUSTED);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(fakes.records).toEqual([]);
    });
  });

  it.each(['/health', '/health/ready'])(
    'lets the probe %s through from the BFF network without a proof',
    async (path) => {
      await boot();

      const response = await http().get(path);

      expect(response.status).not.toBe(400);
      expect(response.body).not.toEqual(UNTRUSTED);
    },
  );

  describe('with the feature off (the default environment)', () => {
    it('refuses a request that carries the header', async () => {
      await boot({});
      seed('AU');

      const response = await signIn(viaBff('AU', CLIENT_A));

      expect(response.status).toBe(400);
      expect(response.body).toEqual(UNTRUSTED);
    });

    it('keys on the socket as before', async () => {
      await boot({});
      seed('AU');

      const response = await signIn({ 'x-market-id': 'AU', 'x-forwarded-for': CLIENT_A });

      expect(response.status).toBe(200);
      expect(fakes.records.map((record) => record.address)).toEqual(['127.0.0.1']);
    });
  });
});
