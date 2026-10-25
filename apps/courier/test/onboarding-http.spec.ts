import { ApiError } from '../src/api/client';
import { createHttpCourierApi, ROUTES } from '../src/api/http-client';
import { ONBOARDING_MARKETS } from './onboarding-markets';

const profile = {
  id: '0b9d3f4e-1111-4222-8333-944445555666',
  status: 'applicant',
  employmentType: 'contractor',
  coldChainCapable: true,
  taxRegistered: false,
  serviceAreaCode: 'zz-central',
  shift: 'offline',
  idleSince: null,
  createdAt: '2026-10-24T09:00:00Z',
  vehicles: [],
  documents: [],
};

function setup(response: { status?: number; body?: unknown }) {
  const fetch = jest.fn<Promise<Response>, [string, RequestInit]>(() =>
    Promise.resolve(
      new Response(response.body === undefined ? '' : JSON.stringify(response.body), {
        status: response.status ?? 200,
      }),
    ),
  );
  const api = createHttpCourierApi({
    baseUrl: 'https://api.example.test',
    session: { current: () => ({ token: 'token-0123456789abcdef', marketId: 'ZZ' }) },
    marketId: 'ZZ',
    fetch,
  });
  return { api, fetch };
}

describe('HTTP adapter: onboarding', () => {
  it('reads the profile, and no profile before the courier applies', async () => {
    const found = setup({ body: { shift: 'offline', activeDeliveryId: null, profile } });
    await expect(found.api.profile()).resolves.toMatchObject({ status: 'applicant' });
    expect(found.fetch.mock.calls[0]![0]).toBe(`https://api.example.test${ROUTES.profile}`);

    const none = setup({ status: 404, body: { code: 'fleet.courier.not-found' } });
    await expect(none.api.profile()).resolves.toBeNull();

    const other = setup({ status: 404, body: { code: 'route.not-found' } });
    await expect(other.api.profile()).rejects.toBeInstanceOf(ApiError);
  });

  it.each(ONBOARDING_MARKETS)(
    'reads the onboarding rules of $settings.marketId from the settings',
    async ({ settings, rules }) => {
      const { api } = setup({ body: { ...settings, ...rules } });
      await expect(api.onboardingRules()).resolves.toEqual(rules);
    },
  );

  it('has no rules while the settings do not carry them', async () => {
    const { api } = setup({ body: ONBOARDING_MARKETS[1]!.settings });
    await expect(api.onboardingRules()).resolves.toBeNull();
  });

  it('applies and adds a vehicle with JSON bodies', async () => {
    const { api, fetch } = setup({ body: profile });
    await api.applyAsCourier({
      employmentType: 'contractor',
      serviceAreaCode: 'zz-central',
      coldChainCapable: true,
    });
    await api.addVehicle({ type: 'van', plate: 'ZZ1', coldBox: 'refrigerated' });
    expect(fetch.mock.calls.map(([url, init]) => [url, init.method, init.body])).toEqual([
      [
        `https://api.example.test${ROUTES.profile}`,
        'POST',
        JSON.stringify({
          employmentType: 'contractor',
          serviceAreaCode: 'zz-central',
          coldChainCapable: true,
        }),
      ],
      [
        `https://api.example.test${ROUTES.vehicles}`,
        'POST',
        JSON.stringify({ type: 'van', plate: 'ZZ1', coldBox: 'refrigerated' }),
      ],
    ]);
  });

  it('uploads a document as multipart with its type, vehicle and expiry', async () => {
    const { api, fetch } = setup({ body: { documentId: 'd-1', profile } });
    await api.submitDocument({
      type: 'vehicle_inspection',
      vehicleId: 'v-1',
      expiresAt: '2030-01-31T23:59:59Z',
      file: { uri: 'file:///doc.pdf', name: 'document.pdf', mimeType: 'application/pdf' },
    });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe(`https://api.example.test${ROUTES.documents}`);
    const form = init.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect(form.get('type')).toBe('vehicle_inspection');
    expect(form.get('vehicleId')).toBe('v-1');
    expect(form.get('expiresAt')).toBe('2030-01-31T23:59:59Z');
    expect(init.headers).not.toHaveProperty('content-type');
  });

  it('refuses a vehicle id that is not one the API issues', async () => {
    const { api, fetch } = setup({ body: {} });
    await expect(
      api.submitDocument({
        type: 'vehicle_inspection',
        vehicleId: '../admin',
        file: { uri: 'file:///doc.pdf', name: 'document.pdf', mimeType: 'application/pdf' },
      }),
    ).rejects.toMatchObject({ code: 'id.invalid' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('takes only an https payout onboarding link', async () => {
    const good = setup({
      body: {
        url: 'https://connect.stripe.com/setup/e/acct_1/abc',
        expiresAt: '2026-10-24T09:05:00Z',
      },
    });
    await expect(good.api.payoutOnboardingLink()).resolves.toMatchObject({
      url: 'https://connect.stripe.com/setup/e/acct_1/abc',
    });
    expect(good.fetch.mock.calls[0]![0]).toBe(`https://api.example.test${ROUTES.payoutOnboarding}`);

    const bad = setup({ body: { url: 'javascript:alert(1)', expiresAt: '2026-10-24T09:05:00Z' } });
    await expect(bad.api.payoutOnboardingLink()).rejects.toMatchObject({
      code: 'response.invalid',
    });
  });
});
