import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/configure-app';
import { MARKET_SETTINGS } from '../src/modules/delivery/application/ports';
import { CLOCK, FixedClock } from '../src/platform/clock/clock';
import { markets } from './support/markets';

// 2026-11-02 09:00 in Brisbane.
const now = new Date('2026-11-01T23:00:00Z');

const cbd = { lat: -27.4698, lng: 153.0251 };
const westEnd = { lat: -27.4818, lng: 153.0089 };

const stop = (postcode: string, point: { lat: number; lng: number }) => ({
  address: '1 Example St',
  postcode,
  point,
  contactName: 'Sam',
  contactPhone: '+61 400 000 000',
});

describe('delivery API', () => {
  let app: INestApplication;
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(MARKET_SETTINGS)
      .useValue(markets)
      .overrideProvider(CLOCK)
      .useValue(new FixedClock(now))
      .compile();
    app = configureApp(moduleRef.createNestApplication());
    await app.init();
  });

  afterAll(() => app.close());

  const booking = {
    merchantId: 'seller-1',
    externalReference: 'suborder-100',
    pickup: stop('4000', cbd),
    dropoff: stop('4101', westEnd),
    parcel: { weightGrams: 4000, volumeLitres: 20, temperature: 'chilled' },
    mode: 'on_demand',
  };

  const quoteRequest = {
    pickup: { postcode: '4000', point: cbd },
    dropoff: { postcode: '4101', point: westEnd },
    parcel: booking.parcel,
    mode: 'on_demand',
  };

  it('quotes a chilled delivery inside Greater Brisbane', async () => {
    const res = await http().post('/v1/markets/AU/quotes').send(quoteRequest).expect(200);
    expect(res.body.serviceArea).toBe('greater-brisbane');
    expect(res.body.vehicle).toBe('bicycle');
    expect(res.body.total.currency).toBe('AUD');
    expect(res.body.distanceMetres).toBeGreaterThan(2000);
  });

  it('refuses a postcode outside the service area', async () => {
    const res = await http()
      .post('/v1/markets/AU/quotes')
      .send({
        ...quoteRequest,
        dropoff: { postcode: '2000', point: { lat: -33.87, lng: 151.21 } },
      })
      .expect(422);
    expect(res.body.code).toBe('service-area.not-served');
  });

  it('books once per merchant reference and runs the delivery to the door', async () => {
    const created = await http().post('/v1/markets/AU/deliveries').send(booking).expect(201);
    const id = created.body.id as string;
    expect(created.body.status).toBe('DISPATCHING');

    const retry = await http().post('/v1/markets/AU/deliveries').send(booking).expect(200);
    expect(retry.body.id).toBe(id);

    const events = [
      { type: 'courier_assigned', courierId: 'courier-7', vehicle: 'bicycle' },
      { type: 'arrived_at_pickup' },
      { type: 'picked_up', temperatureCelsius: 3 },
      { type: 'arrived_at_dropoff' },
      { type: 'delivered', temperatureCelsius: 4, proof: { kind: 'pin', pinMatched: true } },
    ];
    for (const event of events) {
      await http().post(`/v1/markets/AU/deliveries/${id}/events`).send(event).expect(200);
    }
    const done = await http().get(`/v1/markets/AU/deliveries/${id}`).expect(200);
    expect(done.body.status).toBe('DELIVERED');
    expect(done.body.history).toHaveLength(6);
  });

  it('rejects a warm reading for a chilled parcel', async () => {
    const created = await http()
      .post('/v1/markets/AU/deliveries')
      .send({ ...booking, externalReference: 'suborder-101' })
      .expect(201);
    const id = created.body.id as string;
    await http()
      .post(`/v1/markets/AU/deliveries/${id}/events`)
      .send({ type: 'courier_assigned', courierId: 'courier-7', vehicle: 'bicycle' })
      .expect(200);
    await http()
      .post(`/v1/markets/AU/deliveries/${id}/events`)
      .send({ type: 'arrived_at_pickup' })
      .expect(200);
    const res = await http()
      .post(`/v1/markets/AU/deliveries/${id}/events`)
      .send({ type: 'picked_up', temperatureCelsius: 9 })
      .expect(422);
    expect(res.body.code).toBe('cold-chain.breach');
  });

  it('checks a scheduled window against the Market rules', async () => {
    const tooSoon = await http()
      .post('/v1/markets/AU/deliveries')
      .send({
        ...booking,
        externalReference: 'suborder-102',
        mode: 'scheduled',
        window: { start: '2026-11-01T23:30:00Z', end: '2026-11-02T00:30:00Z' },
      })
      .expect(422);
    expect(tooSoon.body.code).toBe('schedule.too-soon');

    const ok = await http()
      .post('/v1/markets/AU/deliveries')
      .send({
        ...booking,
        externalReference: 'suborder-103',
        mode: 'scheduled',
        window: { start: '2026-11-02T13:00:00+10:00', end: '2026-11-02T15:00:00+10:00' },
      })
      .expect(201);
    expect(ok.body.status).toBe('SCHEDULED');
    expect(ok.body.quote.breakdown.scheduledDiscount.amount).toBeLessThan(0);
  });

  it('keeps Markets apart', async () => {
    const created = await http()
      .post('/v1/markets/AU/deliveries')
      .send({ ...booking, externalReference: 'x-1' });
    await http().get(`/v1/markets/ZZ/deliveries/${created.body.id}`).expect(404);
    await http().get(`/v1/markets/NZ/deliveries/${created.body.id}`).expect(404);
  });

  it('validates the request body', async () => {
    const res = await http()
      .post('/v1/markets/AU/quotes')
      .send({ ...quoteRequest, parcel: { weightGrams: -1, volumeLitres: 1, temperature: 'warm' } })
      .expect(400);
    expect(res.body.code).toBe('request.invalid');
    expect(res.body.issues.map((i: { path: string[] }) => i.path.join('.'))).toEqual([
      'parcel.weightGrams',
      'parcel.temperature',
    ]);
  });
});
