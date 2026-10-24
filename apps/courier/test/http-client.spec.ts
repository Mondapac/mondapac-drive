import { ApiError } from '../src/api/client';
import { createHttpCourierApi, ROUTES } from '../src/api/http-client';
import type { CourierSession } from '../src/api/schemas';

const session: CourierSession = {
  token: 'token-0123456789abcdef',
  courierId: 'courier-1',
  marketId: 'ZZ',
  displayName: 'Test',
};

function setup(
  response: { status?: number; body?: unknown } = {},
  current: CourierSession | null = session,
) {
  const fetch = jest.fn<Promise<Response>, [string, RequestInit]>(() =>
    Promise.resolve(
      new Response(response.body === undefined ? '' : JSON.stringify(response.body), {
        status: response.status ?? 200,
      }),
    ),
  );
  const api = createHttpCourierApi({
    baseUrl: 'https://api.example.test/',
    session: { current: () => current },
    fetch,
  });
  return { api, fetch };
}

const job = {
  id: 'd-1',
  status: 'AT_DROPOFF',
  marketId: 'ZZ',
  pickup: {
    address: 'a',
    postcode: '1000',
    point: { lat: 1, lng: 2 },
    contactName: 'm',
    contactPhone: '+1 000000',
  },
  dropoff: {
    address: 'b',
    postcode: '1001',
    point: { lat: 1, lng: 2 },
    contactName: 'c',
    contactPhone: '+1 000000',
  },
  parcel: { weightGrams: 1, volumeLitres: 1, temperature: 'frozen' },
  history: [],
};

describe('HTTP adapter', () => {
  it('sends the bearer token and the Market of the session', async () => {
    const { api, fetch } = setup({ body: job });
    await api.job('d-1');
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe(`https://api.example.test${ROUTES.delivery('d-1')}`);
    expect(init.headers).toMatchObject({
      authorization: `Bearer ${session.token}`,
      'x-market-id': 'ZZ',
    });
  });

  it('sends no token to sign in, and refuses other calls without a session', async () => {
    const { api, fetch } = setup({ body: session }, null);
    await api.signIn({ phone: '+1 555 0100', code: '123456' });
    expect(fetch.mock.calls[0]![1].headers).not.toHaveProperty('authorization');
    await expect(api.status()).rejects.toEqual(new ApiError(401, 'session.missing'));
  });

  it('records a delivery event on the delivery API route with the PIN for the server to check', async () => {
    const { api, fetch } = setup({ body: { ...job, status: 'DELIVERED' } });
    const updated = await api.recordEvent('d-1', {
      type: 'delivered',
      temperatureCelsius: -20,
      proof: { kind: 'pin', pin: '4321' },
    });
    expect(updated.status).toBe('DELIVERED');
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toContain('/delivery/deliveries/d-1/events');
    expect(JSON.parse(init.body as string)).toEqual({
      type: 'delivered',
      temperatureCelsius: -20,
      proof: { kind: 'pin', pin: '4321' },
    });
  });

  it('joins the failure reason and the details into the reason text', async () => {
    const { api, fetch } = setup({ body: { ...job, status: 'DELIVERY_FAILED' } });
    await api.recordEvent('d-1', { type: 'delivery_failed', reason: 'refused', details: ' rude ' });
    expect(JSON.parse(fetch.mock.calls[0]![1].body as string)).toEqual({
      type: 'delivery_failed',
      reason: 'refused: rude',
    });
  });

  it('turns a refusal into its code', async () => {
    const { api } = setup({ status: 422, body: { statusCode: 422, code: 'cold-chain.breach' } });
    await expect(api.recordEvent('d-1', { type: 'arrived_at_dropoff' })).rejects.toEqual(
      new ApiError(422, 'cold-chain.breach'),
    );
  });

  it('refuses a response that does not match the contract', async () => {
    const { api } = setup({ body: { id: 'd-1' } });
    await expect(api.job('d-1')).rejects.toEqual(new ApiError(200, 'response.invalid'));
  });

  it('reports a network failure', async () => {
    const api = createHttpCourierApi({
      baseUrl: 'https://api.example.test',
      session: { current: () => session },
      fetch: () => Promise.reject(new TypeError('Network request failed')),
    });
    await expect(api.earnings()).rejects.toEqual(new ApiError(0, 'network.unavailable'));
  });

  it('refuses an id that is not one the API issues', async () => {
    expect(ROUTES.delivery('d-1')).toBe('/delivery/deliveries/d-1');
    for (const id of ['..', '../x', 'a/b', '', 'x'.repeat(65)]) {
      expect(() => ROUTES.delivery(id)).toThrow(new ApiError(400, 'id.invalid'));
    }
    const { api, fetch } = setup({ body: job });
    await expect(api.job('..')).rejects.toEqual(new ApiError(400, 'id.invalid'));
    expect(fetch).not.toHaveBeenCalled();
  });
});
