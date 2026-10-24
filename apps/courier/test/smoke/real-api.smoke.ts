/**
 * Runs one courier's day through the HTTP adapter against a real API: sign in, Market settings,
 * go online, send a ping, take the current offer (or a delivery already assigned), walk it to
 * delivered with the customer's PIN, read the earnings, go offline and sign out.
 *
 * SMOKE_API_URL, SMOKE_MARKET_ID, SMOKE_COURIER_EMAIL, SMOKE_COURIER_PASSWORD are required;
 * SMOKE_DELIVERY_ID (when no offer is waiting) and SMOKE_DELIVERY_PIN are optional.
 */
import type { ApiError, CourierApi } from '../../src/api/client';
import { createHttpCourierApi } from '../../src/api/http-client';
import type { CourierSession, CourierSettings, Job } from '../../src/api/schemas';
import { nextStep } from '../../src/domain/job-flow';

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for the smoke run`);
  return value;
}

/** A reading inside the limit of the parcel's temperature, as a courier would type it. */
function reading(job: Job, settings: CourierSettings): number | undefined {
  const { temperature } = job.parcel;
  return temperature === 'ambient' ? undefined : settings.coldChain[temperature].maxCelsius - 1;
}

describe('courier app on the real API', () => {
  let session: CourierSession | null = null;
  const api: CourierApi = createHttpCourierApi({
    baseUrl: required('SMOKE_API_URL'),
    marketId: required('SMOKE_MARKET_ID'),
    session: { current: () => session },
  });

  it('runs a delivery from sign-in to sign-out', async () => {
    session = await api.signIn({
      email: required('SMOKE_COURIER_EMAIL'),
      password: required('SMOKE_COURIER_PASSWORD'),
    });
    const settings = await api.settings();
    expect(settings.marketId).toBe(session.marketId);

    expect((await api.setShift('online')).shift).toBe('online');
    await api.sendPings([
      { lat: -27.4698, lng: 153.0251, accuracyM: 10, recordedAt: new Date().toISOString() },
    ]);

    const offer = await api.currentOffer();
    const deliveryId = offer
      ? (await api.acceptOffer(offer.id)).deliveryId
      : required('SMOKE_DELIVERY_ID');

    let job = await api.job(deliveryId);
    const temperatureCelsius = reading(job, settings);
    for (let guard = 0; guard < 5; guard += 1) {
      const step = nextStep(job.status);
      if (step === 'finished' || step === 'waiting') break;
      switch (step) {
        case 'arrive_at_pickup':
          job = await api.recordEvent(deliveryId, { type: 'arrived_at_pickup' });
          break;
        case 'pick_up':
          job = await api.recordEvent(deliveryId, { type: 'picked_up', temperatureCelsius });
          break;
        case 'arrive_at_dropoff':
          job = await api.recordEvent(deliveryId, { type: 'arrived_at_dropoff' });
          break;
        case 'deliver':
          job = await api.recordEvent(deliveryId, {
            type: 'delivered',
            proof: { kind: 'pin', pin: required('SMOKE_DELIVERY_PIN') },
            temperatureCelsius,
          });
          break;
      }
    }
    expect(job.status).toBe('DELIVERED');

    const earnings = await api.earnings();
    expect(earnings.today.currency).toBe(settings.currency);

    await api.setShift('offline');
    const token = session;
    await api.signOut();
    // The signed-out token is refused from now on.
    await expect(
      createHttpCourierApi({
        baseUrl: required('SMOKE_API_URL'),
        marketId: token.marketId,
        session: { current: () => token },
      }).status(),
    ).rejects.toMatchObject({ status: 401 } satisfies Partial<ApiError>);
  });
});
