import { ApiError } from '../src/api/client';
import { createHttpCourierApi, ROUTES } from '../src/api/http-client';
import type { CourierSession } from '../src/api/schemas';

const session: CourierSession = {
  token: 'token-0123456789abcdef',
  marketId: 'ZZ',
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
    marketId: 'ZZ',
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

  it("signs in on identity's courier route, scoped to the build's Market", async () => {
    const { api, fetch } = setup(
      {
        body: {
          code: 'signed-in',
          token: session.token,
          absoluteLifetimeSeconds: 2_592_000,
          idleTimeoutSeconds: 604_800,
        },
      },
      null,
    );
    await expect(
      api.signIn({ email: 'courier@example.test', password: 'secret-1' }),
    ).resolves.toEqual({ token: session.token, marketId: 'ZZ' });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('https://api.example.test/identity/courier/sign-in');
    expect(init.headers).toMatchObject({ 'x-market-id': 'ZZ' });
    expect(init.headers).not.toHaveProperty('authorization');
    expect(JSON.parse(init.body as string)).toEqual({
      email: 'courier@example.test',
      password: 'secret-1',
    });
    await expect(api.status()).rejects.toEqual(new ApiError(401, 'session.missing'));
  });

  it('turns a refused sign-in into its code', async () => {
    const { api } = setup(
      { status: 401, body: { statusCode: 401, code: 'credentials.invalid' } },
      null,
    );
    await expect(api.signIn({ email: 'courier@example.test', password: 'x' })).rejects.toEqual(
      new ApiError(401, 'credentials.invalid'),
    );
  });

  it('signs out of the bearer session', async () => {
    const { api, fetch } = setup({ body: { code: 'signed-out' } });
    await api.signOut();
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('https://api.example.test/identity/courier/sign-out');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({ authorization: `Bearer ${session.token}` });
  });

  it('sends pings in one batch without a courier id', async () => {
    const { api, fetch } = setup();
    const ping = { lat: 1, lng: 2, accuracyM: 5, recordedAt: '2026-10-24T09:00:00.000Z' };
    await api.sendPings([ping]);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('https://api.example.test/tracking/courier/pings');
    expect(JSON.parse(init.body as string)).toEqual({ pings: [ping] });
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
    expect(url).toContain('/delivery/courier/deliveries/d-1/events');
    expect(JSON.parse(init.body as string)).toEqual({
      type: 'delivered',
      temperatureCelsius: -20,
      proof: { kind: 'pin', pin: '4321' },
    });
  });

  it('uploads a proof photo as the multipart part `photo` and reads the 201 reference', async () => {
    const { api, fetch } = setup({ status: 201, body: { photoRef: 'f1b0c7e2-photo' } });
    const result = await api.uploadProofPhoto('d-1', {
      uri: 'file:///compressed.jpg',
      mimeType: 'image/jpeg',
    });
    expect(result).toEqual({ photoRef: 'f1b0c7e2-photo' });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe(`https://api.example.test${ROUTES.proofPhotos('d-1')}`);
    expect(init.method).toBe('POST');
    expect(init.body).toBeInstanceOf(FormData);
    // The boundary is fetch's to set: no JSON content type on a multipart body.
    expect(init.headers).not.toHaveProperty('content-type');
  });

  it("reads dispatch's current offer, which has no pay until payouts quotes it", async () => {
    const offer = {
      id: 'o-1',
      deliveryId: 'd-1',
      expiresAt: '2026-10-24T09:00:30Z',
      pickup: { address: 'a', point: { lat: 1, lng: 2 } },
      dropoff: { address: 'b', point: { lat: 1, lng: 2 } },
      distanceMetres: 2300,
      temperature: 'chilled',
    };
    const { api, fetch } = setup({ body: { offer } });
    expect(await api.currentOffer()).toEqual(offer);
    expect(fetch.mock.calls[0]![0]).toBe(
      'https://api.example.test/dispatch/courier/offers/current',
    );
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
      marketId: 'ZZ',
      fetch: () => Promise.reject(new TypeError('Network request failed')),
    });
    await expect(api.earnings()).rejects.toEqual(new ApiError(0, 'network.unavailable'));
  });

  it('refuses an id that is not one the API issues', async () => {
    expect(ROUTES.delivery('d-1')).toBe('/delivery/courier/deliveries/d-1');
    for (const id of ['..', '../x', 'a/b', '', 'x'.repeat(65)]) {
      expect(() => ROUTES.delivery(id)).toThrow(new ApiError(400, 'id.invalid'));
    }
    const { api, fetch } = setup({ body: job });
    await expect(api.job('..')).rejects.toEqual(new ApiError(400, 'id.invalid'));
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('the accepted delivery while fleet reports none', () => {
  function memory(initial: string | null = null) {
    let stored = initial;
    return {
      current: () => stored,
      remember: jest.fn((id: string) => {
        stored = id;
        return Promise.resolve();
      }),
      forget: jest.fn(() => {
        stored = null;
        return Promise.resolve();
      }),
    };
  }

  function respond(...bodies: { status?: number; body?: unknown }[]) {
    const fetch = jest.fn<Promise<Response>, [string, RequestInit]>();
    for (const { status, body } of bodies) {
      fetch.mockResolvedValueOnce(
        new Response(body === undefined ? '' : JSON.stringify(body), { status: status ?? 200 }),
      );
    }
    return fetch;
  }

  function api(fetch: ReturnType<typeof respond>, activeJob: ReturnType<typeof memory>) {
    return createHttpCourierApi({
      baseUrl: 'https://api.example.test',
      session: { current: () => session },
      marketId: 'ZZ',
      fetch,
      activeJob,
    });
  }

  it('remembers the accepted delivery and reports it as the active one', async () => {
    const activeJob = memory();
    const fetch = respond(
      { body: { deliveryId: 'd-1' } },
      { body: { shift: 'on_delivery', activeDeliveryId: null } },
    );
    const courier = api(fetch, activeJob);
    await courier.acceptOffer('o-1');
    expect(activeJob.remember).toHaveBeenCalledWith('d-1');
    await expect(courier.status()).resolves.toEqual({
      shift: 'on_delivery',
      activeDeliveryId: 'd-1',
    });
  });

  it("takes the server's active delivery over the remembered one", async () => {
    const fetch = respond({ body: { shift: 'on_delivery', activeDeliveryId: 'd-2' } });
    await expect(api(fetch, memory('d-1')).status()).resolves.toMatchObject({
      activeDeliveryId: 'd-2',
    });
  });

  it('forgets the delivery once it is finished or no longer the courier’s', async () => {
    const finished = memory('d-1');
    await api(respond({ body: { ...job, status: 'DELIVERED' } }), finished).job('d-1');
    expect(finished.forget).toHaveBeenCalled();

    const taken = memory('d-1');
    await expect(
      api(respond({ status: 404, body: { code: 'delivery.not-found' } }), taken).job('d-1'),
    ).rejects.toMatchObject({ status: 404 });
    expect(taken.forget).toHaveBeenCalled();

    const ongoing = memory('d-1');
    await api(respond({ body: job }), ongoing).job('d-1');
    expect(ongoing.forget).not.toHaveBeenCalled();
  });
});
