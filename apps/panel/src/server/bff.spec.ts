import { describe, expect, it, vi } from 'vitest';
import { relay, upstreamHeaders } from './bff.ts';
import type { PanelConfig } from './config.ts';

const config: PanelConfig = {
  apiBaseUrl: 'http://api.test',
  hosts: [{ origin: 'http://admin.localhost:3002', host: 'admin.localhost:3002', marketId: 'AU' }],
  passwordMinLength: 15,
  passwordMaxLength: 128,
  marketName: 'Australia',
  locale: 'en-AU',
  supportEmail: 'support@example.com',
  clientAddressKey: null,
};

const sameOrigin = {
  host: 'admin.localhost:3002',
  origin: 'http://admin.localhost:3002',
  'sec-fetch-site': 'same-origin',
  'content-type': 'application/json',
};

function post(path: string, headers: Record<string, string> = sameOrigin, body = '{}') {
  return new Request(`http://admin.localhost:3002/api/${path}`, { method: 'POST', headers, body });
}

const upstreamOk = () =>
  vi.fn<typeof fetch>(() => Promise.resolve(new Response('{"code":"signed-in"}', { status: 200 })));

describe('relay logging', () => {
  it('logs the status and the API correlation id for an error answer, and nothing secret', async () => {
    const log = vi.fn();
    const upstream = new Response('{"code":"credentials.invalid"}', {
      status: 401,
      headers: { 'x-correlation-id': 'abc-123' },
    });
    await relay(
      config,
      post(
        'identity/admin/sign-in',
        { ...sameOrigin, cookie: 'secret=1' },
        '{"password":"hunter2"}',
      ),
      ['identity', 'admin', 'sign-in'],
      () => Promise.resolve(upstream),
      log,
    );
    expect(log).toHaveBeenCalledWith({
      msg: 'panel.relay.error-answer',
      method: 'POST',
      path: 'identity/admin/sign-in',
      status: 401,
      marketId: 'AU',
      correlationId: 'abc-123',
    });
    expect(JSON.stringify(log.mock.calls)).not.toContain('hunter2');
    expect(JSON.stringify(log.mock.calls)).not.toContain('secret=1');
  });

  it('logs an unreachable API and stays quiet on success', async () => {
    const log = vi.fn();
    await relay(
      config,
      post('identity/admin/sign-in'),
      ['identity', 'admin', 'sign-in'],
      () => Promise.reject(new Error('down')),
      log,
    );
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({ msg: 'panel.relay.upstream-unreachable' }),
    );
    const quiet = vi.fn();
    await relay(
      config,
      post('identity/admin/sign-in'),
      ['identity', 'admin', 'sign-in'],
      () => Promise.resolve(new Response('{}', { status: 200 })),
      quiet,
    );
    expect(quiet).not.toHaveBeenCalled();
  });
});

describe('relay', () => {
  it('answers 404 for a host that is not listed', async () => {
    const fetchImpl = upstreamOk();
    const response = await relay(
      config,
      post('identity/admin/sign-in', { ...sameOrigin, host: 'evil.test' }),
      ['identity', 'admin', 'sign-in'],
      fetchImpl,
    );
    expect(response.status).toBe(404);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('answers 404 for a path outside the allowlist', async () => {
    const fetchImpl = upstreamOk();
    const response = await relay(
      config,
      post('identity/courier/sign-in'),
      ['identity', 'courier', 'sign-in'],
      fetchImpl,
    );
    expect(response.status).toBe(404);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    'identity/admin/password-reset-email',
    'identity/admin/reset-password',
    'identity/admin/invitation/enrolment',
    'identity/admin/invitation/accept',
  ])('relays the anonymous password routes (%s)', async (path) => {
    const response = await relay(config, post(path), path.split('/'), upstreamOk());
    expect(response.status).toBe(200);
  });

  it.each([
    'identity/admin/password-reset-email',
    'identity/admin/reset-password',
    'identity/admin/invitation/enrolment',
    'identity/admin/invitation/accept',
  ])('refuses a cross-site POST to %s', async (path) => {
    const fetchImpl = upstreamOk();
    const response = await relay(
      config,
      post(path, { ...sameOrigin, 'sec-fetch-site': 'cross-site' }),
      path.split('/'),
      fetchImpl,
    );
    expect(response.status).toBe(403);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('relays the id paths of the team commands, and only with a UUID id', async () => {
    const id = '0190a000-0000-7000-8000-000000000001';
    const ok = upstreamOk();
    const allowed = await relay(
      config,
      post(`identity/admin/accounts/${id}/disable`),
      ['identity', 'admin', 'accounts', id, 'disable'],
      ok,
    );
    expect(allowed.status).toBe(200);
    for (const path of [
      ['identity', 'admin', 'accounts', 'not-a-uuid', 'disable'],
      ['identity', 'admin', 'accounts', id, 'password'],
      ['identity', 'admin', 'accounts', id, 'disable', 'extra'],
      ['identity', 'admin', 'sessions', id, 'disable'],
      ['identity', 'admin', 'accounts', `${id}%2F..`, 'disable'],
      ['identity', 'admin', 'accounts', '..', 'disable'],
      ['identity', 'admin', 'accounts', id, 'disable', ''],
    ]) {
      const fetchImpl = upstreamOk();
      const response = await relay(config, post(path.join('/')), path, fetchImpl);
      expect(response.status).toBe(404);
      expect(fetchImpl).not.toHaveBeenCalled();
    }
  });

  it('relays change-role and invite, and refuses near misses and cross-site posts', async () => {
    const id = '0190a000-0000-7000-8000-000000000001';
    for (const path of [
      ['identity', 'admin', 'accounts', id, 'role'],
      ['identity', 'admin', 'invitations'],
    ]) {
      const ok = upstreamOk();
      expect((await relay(config, post(path.join('/')), path, ok)).status).toBe(200);
      const blocked = upstreamOk();
      const crossSite = { ...sameOrigin, 'sec-fetch-site': 'cross-site' };
      const response = await relay(config, post(path.join('/'), crossSite), path, blocked);
      expect(response.status).toBe(403);
      expect(blocked).not.toHaveBeenCalled();
    }
    for (const path of [
      ['identity', 'admin', 'invitations', id],
      ['identity', 'admin', 'invitations', 'x'],
      ['identity', 'admin', 'accounts', 'not-a-uuid', 'role'],
      ['identity', 'admin', 'accounts', id, 'role', 'extra'],
      ['identity', 'admin', 'accounts', `${id}%2F..`, 'role'],
    ]) {
      const fetchImpl = upstreamOk();
      const response = await relay(config, post(path.join('/')), path, fetchImpl);
      expect(response.status).toBe(404);
      expect(fetchImpl).not.toHaveBeenCalled();
    }
  });

  it('refuses an unsafe request that is not same-origin', async () => {
    const fetchImpl = upstreamOk();
    const crossSite = { ...sameOrigin, 'sec-fetch-site': 'cross-site' };
    expect(
      (
        await relay(
          config,
          post('identity/admin/sign-in', crossSite),
          ['identity', 'admin', 'sign-in'],
          fetchImpl,
        )
      ).status,
    ).toBe(403);
    const otherOrigin = { ...sameOrigin, origin: 'http://evil.test' };
    expect(
      (
        await relay(
          config,
          post('identity/admin/sign-in', otherOrigin),
          ['identity', 'admin', 'sign-in'],
          fetchImpl,
        )
      ).status,
    ).toBe(403);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses an Authorization header', async () => {
    const fetchImpl = upstreamOk();
    const response = await relay(
      config,
      post('identity/admin/sign-in', { ...sameOrigin, authorization: 'Bearer x' }),
      ['identity', 'admin', 'sign-in'],
      fetchImpl,
    );
    expect(response.status).toBe(401);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses a body over 16 KB', async () => {
    const fetchImpl = upstreamOk();
    const response = await relay(
      config,
      post('identity/admin/sign-in', sameOrigin, 'x'.repeat(16 * 1024 + 1)),
      ['identity', 'admin', 'sign-in'],
      fetchImpl,
    );
    expect(response.status).toBe(413);
  });

  it('refuses a streamed body over the cap without a Content-Length', async () => {
    const fetchImpl = upstreamOk();
    const big = new Uint8Array(16 * 1024 + 1).fill(120);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(big.slice(0, 8000));
        controller.enqueue(big.slice(8000));
        controller.close();
      },
    });
    const request = new Request('http://admin.localhost:3002/api/identity/admin/sign-in', {
      method: 'POST',
      headers: sameOrigin,
      body: stream,
      duplex: 'half',
    } as RequestInit);
    const response = await relay(config, request, ['identity', 'admin', 'sign-in'], fetchImpl);
    expect(response.status).toBe(413);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses at once when Content-Length is over the cap', async () => {
    const fetchImpl = upstreamOk();
    const response = await relay(
      config,
      post('identity/admin/sign-in', { ...sameOrigin, 'content-length': '99999' }),
      ['identity', 'admin', 'sign-in'],
      fetchImpl,
    );
    expect(response.status).toBe(413);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('sends only allowlisted headers and the Market of the host', async () => {
    const fetchImpl = upstreamOk();
    await relay(
      config,
      post('identity/admin/sign-in', {
        ...sameOrigin,
        cookie: 'a=b',
        'x-market-id': 'NZ',
        'x-forwarded-for': '1.2.3.4',
        'x-csrf-token': 't',
        'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) Firefox/143.0',
      }),
      ['identity', 'admin', 'sign-in'],
      fetchImpl,
    );
    const init = fetchImpl.mock.calls[0]![1]!;
    const sent = init.headers as Headers;
    expect(sent.get('x-market-id')).toBe('AU');
    expect(sent.get('cookie')).toBe('a=b');
    expect(sent.get('x-csrf-token')).toBe('t');
    // The API reduces it to a browser and system code on a new session (profile).
    expect(sent.get('user-agent')).toBe('Mozilla/5.0 (X11; Linux x86_64) Firefox/143.0');
    expect(sent.has('x-forwarded-for')).toBe(false);
    expect(sent.has('host')).toBe(false);
  });

  it('relays every Set-Cookie and defaults to no-store', async () => {
    const upstream = new Response('{}', { status: 200 });
    upstream.headers.append('set-cookie', '__Host-session-admin-AU=abc; Path=/; Secure; HttpOnly');
    upstream.headers.append('set-cookie', 'other=1; Path=/');
    const response = await relay(
      config,
      post('identity/admin/sign-in'),
      ['identity', 'admin', 'sign-in'],
      () => Promise.resolve(upstream),
    );
    expect(response.headers.getSetCookie()).toHaveLength(2);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
  });

  it('answers 503 when the API is unreachable', async () => {
    const response = await relay(
      config,
      post('identity/admin/sign-in'),
      ['identity', 'admin', 'sign-in'],
      () => Promise.reject(new Error('down')),
    );
    expect(response.status).toBe(503);
  });
});

describe('signed client address (ADR-0037)', () => {
  const key = {
    keyId: 'panel',
    secret: Buffer.from('AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=', 'base64'),
  };
  const signing: PanelConfig = { ...config, clientAddressKey: key };
  const host = config.hosts[0]!;
  const at = () => 1791417600_000;
  const signed =
    'v1;k=panel;t=1791417600;a=203.0.113.7;s=VBHNrLXY_bKDvCMXHp-hfnqKb98sQZ90DnvOVDTYIj8';

  it('sends no header when no key is set', () => {
    const request = new Request('http://admin.localhost:3002/', {
      headers: { 'x-drive-client-address': '203.0.113.7', 'x-client-address': 'forged' },
    });
    expect(upstreamHeaders(request, host, config, at).has('x-client-address')).toBe(false);
  });

  it('signs the address set by the panel server and overwrites a browser-sent header', () => {
    const request = new Request('http://admin.localhost:3002/', {
      headers: { 'x-drive-client-address': '203.0.113.7', 'x-client-address': 'forged' },
    });
    const headers = upstreamHeaders(request, host, signing, at);
    expect(headers.get('x-client-address')).toBe(signed);
    expect(headers.has('x-drive-client-address')).toBe(false);
  });

  it('refuses to relay without x-drive-client-address, and the API is never called', async () => {
    const upstream = upstreamOk();
    const log = vi.fn();
    const response = await relay(
      signing,
      post('identity/admin/sign-in', { ...sameOrigin, 'x-client-address': 'forged' }),
      ['identity', 'admin', 'sign-in'],
      upstream,
      log,
    );
    expect(response.status).toBe(503);
    expect(upstream).not.toHaveBeenCalled();
  });

  it('sends the signed header on a relayed request', async () => {
    const upstream = upstreamOk();
    const response = await relay(
      signing,
      post('identity/admin/sign-in', { ...sameOrigin, 'x-drive-client-address': '203.0.113.7' }),
      ['identity', 'admin', 'sign-in'],
      upstream,
      vi.fn(),
    );
    expect(response.status).toBe(200);
    // The vectors fix t, so only the shape is checked here; the signature has its own vectors.
    const sent = new Headers(upstream.mock.calls[0]?.[1]?.headers);
    expect(sent.get('x-client-address')).toMatch(/^v1;k=panel;t=\d+;a=203\.0\.113\.7;s=/);
  });

  it('relays the role editor routes, with a UUID id for edit and delete only', async () => {
    const id = '0190a000-0000-7000-8000-000000000001';
    const request = (method: string, path: string) =>
      new Request(`http://admin.localhost:3002/api/${path}`, {
        method,
        headers: sameOrigin,
        ...(method === 'DELETE' ? {} : { body: '{}' }),
      });
    for (const [method, path] of [
      ['POST', 'identity/admin/roles'],
      ['PUT', `identity/admin/roles/${id}`],
      ['DELETE', `identity/admin/roles/${id}`],
    ] as const) {
      const ok = upstreamOk();
      expect((await relay(config, request(method, path), path.split('/'), ok)).status).toBe(200);
    }
    for (const [method, path] of [
      ['PUT', 'identity/admin/roles'],
      ['DELETE', 'identity/admin/roles'],
      ['DELETE', 'identity/admin/roles/not-a-uuid'],
      ['POST', `identity/admin/roles/${id}`],
      ['PUT', `identity/admin/roles/${id}/extra`],
    ] as const) {
      const fetchImpl = upstreamOk();
      const response = await relay(config, request(method, path), path.split('/'), fetchImpl);
      expect(response.status).toBe(404);
      expect(fetchImpl).not.toHaveBeenCalled();
    }
  });
});

describe('relay allowlist of the Drive operations routes', () => {
  const ID = '0190a000-0000-7000-8000-0000000000a1';
  const KEY = '0190a000-0000-7000-8000-0000000000b2';
  const call = (method: string, path: string, headers: Record<string, string> = sameOrigin) => {
    const fetchImpl = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response('{}', { status: 200 })),
    );
    return relay(
      config,
      new Request(`http://admin.localhost:3002/api/${path}`, {
        method,
        headers,
        ...(method === 'GET' || method === 'DELETE' ? {} : { body: '{}' }),
      }),
      path.split('/'),
      fetchImpl,
    ).then((response) => ({ status: response.status, called: fetchImpl.mock.calls.length }));
  };

  it('relays the own display name (PUT) and password change (POST) on their exact paths only', async () => {
    const name = 'identity/admin/profile/display-name';
    expect((await call('PUT', name)).status).toBe(200);
    expect((await call('POST', name)).status).toBe(404);
    expect((await call('PUT', `${name}/extra`)).status).toBe(404);
    const password = 'identity/admin/change-password';
    expect((await call('POST', password)).status).toBe(200);
    expect((await call('PUT', password)).status).toBe(404);
  });

  it.each([
    'identity/admin/merchants',
    `identity/admin/merchants/${ID}/suspend`,
    `identity/admin/merchants/${ID}/reinstate`,
    `identity/admin/merchants/${ID}/api-keys`,
    `identity/admin/merchants/${ID}/api-keys/${KEY}/revoke`,
    'identity/admin/couriers/invitations',
    `identity/admin/couriers/${ID}/disable`,
    `identity/admin/couriers/${ID}/enable`,
    `delivery/admin/deliveries/${ID}/dispatch`,
    `delivery/admin/deliveries/${ID}/cancel`,
  ])('relays POST %s same-origin only', async (path) => {
    expect(await call('POST', path)).toEqual({ status: 200, called: 1 });
    const crossSite = { ...sameOrigin, 'sec-fetch-site': 'cross-site' };
    expect(await call('POST', path, crossSite)).toEqual({ status: 403, called: 0 });
    expect(await call('PUT', path)).toEqual({ status: 404, called: 0 });
  });

  it.each([
    // The lists and one delivery are read by the page server, never through the relay.
    ['GET', 'identity/admin/merchants'],
    ['GET', `identity/admin/merchants/${ID}/api-keys`],
    ['GET', 'identity/admin/couriers'],
    ['GET', 'delivery/admin/deliveries'],
    ['GET', `delivery/admin/deliveries/${ID}`],
    // Near misses: a bad id, an extra segment, another population's routes.
    ['POST', 'identity/admin/merchants/not-a-uuid/suspend'],
    ['POST', `identity/admin/merchants/${ID}/api-keys/not-a-uuid/revoke`],
    ['POST', `identity/admin/merchants/${ID}/api-keys/${KEY}`],
    ['POST', `identity/admin/couriers/${ID}/disable/extra`],
    ['POST', `delivery/admin/deliveries/${ID}/events`],
    ['POST', 'delivery/deliveries'],
    ['POST', `delivery/courier/deliveries/${ID}/events`],
    ['POST', 'delivery/quotes'],
  ])('refuses %s %s (404) without calling the API', async (method, path) => {
    expect(await call(method, path)).toEqual({ status: 404, called: 0 });
  });
});

describe('relay of the live map routes (Drive)', () => {
  const ID = '0190a000-0000-7000-8000-0000000000a1';
  const get = (url: string, answer: () => Response = () => new Response('{}', { status: 200 })) => {
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.resolve(answer()));
    const path = new URL(url, 'http://admin.localhost:3002/api/').pathname
      .replace(/^\/api\//, '')
      .split('/');
    return relay(
      config,
      new Request(`http://admin.localhost:3002/api/${url}`, {
        headers: { host: 'admin.localhost:3002', accept: 'text/event-stream' },
      }),
      path,
      fetchImpl,
    ).then((response) => ({ response, fetchImpl }));
  };

  it.each(['tracking/admin/couriers/nearest', 'tracking/admin/map/stream'])(
    'relays GET %s with the point, radius and limit only, in their shapes',
    async (path) => {
      const { response, fetchImpl } = await get(
        `${path}?lat=-27.4698&lng=153.0251&radiusM=8000&limit=50&courierId=x&serviceArea=a`,
      );
      expect(response.status).toBe(200);
      expect(fetchImpl.mock.calls[0]?.[0]).toBe(
        `http://api.test/${path}?lat=-27.4698&lng=153.0251&radiusM=8000&limit=50`,
      );
    },
  );

  it('drops a point with more than 4 decimals and a radius that is not a whole number', async () => {
    const { fetchImpl } = await get(
      'tracking/admin/map/stream?lat=-27.469812&lng=153.0251&radiusM=8000.5&limit=10',
    );
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      'http://api.test/tracking/admin/map/stream?lng=153.0251&limit=10',
    );
  });

  it('relays a delivery trail with a UUID id only, and no other tracking route', async () => {
    expect((await get(`tracking/admin/deliveries/${ID}/trail`)).response.status).toBe(200);
    for (const path of [
      'tracking/admin/deliveries/not-a-uuid/trail',
      `tracking/admin/couriers/${ID}/position`,
      'tracking/courier/pings',
      'tracking/links/abc',
    ]) {
      const { response, fetchImpl } = await get(path);
      expect(response.status, path).toBe(404);
      expect(fetchImpl).not.toHaveBeenCalled();
    }
  });

  it('streams an event stream through without buffering it', async () => {
    const encoder = new TextEncoder();
    let push: ((text: string) => void) | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        push = (text) => controller.enqueue(encoder.encode(text));
      },
    });
    const { response } = await get(
      'tracking/admin/map/stream?lat=1&lng=2&radiusM=1000',
      () => new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    );
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    expect(response.headers.get('cache-control')).toBe('no-store, no-transform');
    // The stream has not ended, yet the first event is readable: nothing waits for the whole body.
    push?.('event: couriers\ndata: {"couriers":[]}\n\n');
    const reader = response.body?.getReader();
    const first = await reader?.read();
    expect(new TextDecoder().decode(first?.value)).toContain('event: couriers');
    await reader?.cancel();
  });

  it('passes the browser request signal to the API request', async () => {
    const { fetchImpl } = await get('tracking/admin/map/stream?lat=1&lng=2&radiusM=1000');
    expect(fetchImpl.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });
});
