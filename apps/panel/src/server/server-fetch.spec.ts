import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));

vi.mock('next/headers', () => ({
  headers: () => Promise.resolve(new Headers({ host: 'admin.localhost:3002', cookie: 'sid=1' })),
}));
vi.mock('./config.ts', () => ({ panelConfig: () => ({ apiBaseUrl: 'http://api.test' }) }));
vi.mock('./bff.ts', () => ({
  panelHostFor: () => ({ origin: 'http://admin.localhost:3002', marketId: 'AU' }),
  // The real function copies the forwarded headers and adds the Market; the copy is enough here.
  upstreamHeaders: (request: Request) => new Headers(request.headers),
}));

import { serverGet } from './server-fetch.ts';

describe('serverGet', () => {
  beforeEach(() => {
    mocks.fetch.mockReset();
    mocks.fetch.mockResolvedValue(new Response(JSON.stringify({ ok: 1 }), { status: 200 }));
    vi.stubGlobal('fetch', mocks.fetch);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('reads with GET and no body by default', async () => {
    await expect(serverGet('pricing/admin/price-holds')).resolves.toEqual({
      kind: 'ok',
      body: { ok: 1 },
    });
    const [url, init] = mocks.fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://api.test/pricing/admin/price-holds');
    expect(init.method).toBe('GET');
    expect(init.body).toBeUndefined();
    expect((init.headers as Headers).has('x-csrf-token')).toBe(false);
  });

  it('sends a read the API takes as a POST with the body, the CSRF token and the same-origin headers', async () => {
    await serverGet('sellers/admin/list', {
      post: { body: { tab: 'awaiting-review', limit: 5 }, csrfToken: 'csrf-1' },
    });
    const [, init] = mocks.fetch.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Headers;
    expect(init.method).toBe('POST');
    expect(init.body).toBe(JSON.stringify({ tab: 'awaiting-review', limit: 5 }));
    expect(headers.get('x-csrf-token')).toBe('csrf-1');
    expect(headers.get('origin')).toBe('http://admin.localhost:3002');
    expect(headers.get('sec-fetch-site')).toBe('same-origin');
    expect(headers.get('content-type')).toBe('application/json');
    expect(headers.get('cookie')).toBe('sid=1');
  });

  it('maps a refusal to its kind', async () => {
    mocks.fetch.mockResolvedValue(new Response('{}', { status: 403 }));
    await expect(serverGet('x')).resolves.toEqual({ kind: 'forbidden' });
  });
});
