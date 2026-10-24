// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';
import type { MapDelivery, NearbyCourier } from './model.ts';
import type { MapStreamOptions, StreamQuery } from './map-stream.ts';

vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));
// MapLibre needs WebGL; the canvas is replaced by a list of what it would draw.
vi.mock('./map-canvas.tsx', () => ({
  MapCanvas: (props: { couriers: readonly NearbyCourier[]; trail: readonly unknown[] }) => (
    <div data-testid="canvas">
      {props.couriers.length} couriers, {props.trail.length} crumbs
    </div>
  ),
}));
const streams: { options: MapStreamOptions; queries: StreamQuery[]; stopped: boolean }[] = [];
vi.mock('./map-stream.ts', () => ({
  MapStream: class {
    readonly record: (typeof streams)[number];
    constructor(options: MapStreamOptions) {
      this.record = { options, queries: [], stopped: false };
      streams.push(this.record);
    }
    start(query: StreamQuery) {
      this.record.queries.push(query);
    }
    stop() {
      this.record.stopped = true;
    }
  },
}));

import { callApi } from '../api/client.ts';
import { LiveMap, type LiveMapProps } from './live-map.tsx';

const call = vi.mocked(callApi);
const DELIVERY = '0190a000-0000-7000-8000-000000000001';
const FAILED = '0190a000-0000-7000-8000-000000000002';
const COURIER = '0190a000-0000-7000-8000-0000000000c1';

const deliveries: MapDelivery[] = [
  {
    id: DELIVERY,
    reference: 'ORD-100',
    status: 'ASSIGNED',
    temperature: 'chilled',
    courierId: COURIER,
    pickup: { lat: 35.6812, lng: 139.7671 },
    dropoff: { lat: 35.69, lng: 139.7 },
    exception: null,
  },
  {
    id: FAILED,
    reference: 'ORD-200',
    status: 'DELIVERY_FAILED',
    temperature: 'ambient',
    courierId: null,
    pickup: null,
    dropoff: null,
    exception: 'failed',
  },
];

function show(overrides: Partial<LiveMapProps> = {}) {
  render(
    <NextIntlClientProvider locale="en-AU" timeZone="UTC" messages={messages}>
      <LiveMap
        styleUrl="https://tiles.example.com/style.json?key=k"
        center={{ lat: 35.6812, lng: 139.7671 }}
        zoom={11}
        deliveries={deliveries}
        courierNames={{ [COURIER]: 'Sam Courier' }}
        {...overrides}
      />
    </NextIntlClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  streams.length = 0;
});
afterEach(cleanup);

describe('live map', () => {
  it('opens the stream on the Market center and stops it when the page goes', () => {
    show();
    expect(streams[0]?.queries[0]).toEqual({
      center: { lat: 35.6812, lng: 139.7671 },
      radiusM: 20_000,
      limit: 50,
    });
    cleanup();
    expect(streams[0]?.stopped).toBe(true);
  });

  it('lists the streamed couriers by name, or a short id when the name is not readable', () => {
    show();
    act(() => {
      streams[0]?.options.onState('live');
      streams[0]?.options.onCouriers([
        {
          courierId: COURIER,
          lat: 1,
          lng: 2,
          accuracyM: 5,
          recordedAt: '2026-10-24T09:00:00Z',
          distanceM: 10,
        },
        {
          courierId: '0190a000-0000-7000-8000-0000000000c2',
          lat: 1,
          lng: 2,
          accuracyM: 5,
          recordedAt: '2026-10-24T09:00:05Z',
          distanceM: 20,
        },
      ]);
    });
    expect(screen.getByText('Live')).toBeTruthy();
    expect(screen.getByText('Couriers in view (2)')).toBeTruthy();
    expect(screen.getByText('Sam Courier')).toBeTruthy();
    expect(screen.getByText('000000C2')).toBeTruthy();
    expect(screen.getByTestId('canvas').textContent).toContain('2 couriers');
  });

  it('lists exceptions with a link to the dispatch panel, and no map link without a point', () => {
    show();
    expect(screen.getByText('Exceptions (1)')).toBeTruthy();
    expect(screen.getAllByText('Delivery failed')).toHaveLength(2);
    const links = screen
      .getAllByRole('link', { name: 'Open dispatch panel' })
      .map((link) => link.getAttribute('href'));
    expect(links).toEqual([`/deliveries/${FAILED}`]);
  });

  it('shows a delivery trail and the couriers nearest its pickup', async () => {
    show();
    fireEvent.click(screen.getByRole('button', { name: 'ORD-100' }));
    expect(screen.getByText('Delivery ORD-100')).toBeTruthy();
    expect(screen.getByText('Courier: Sam Courier')).toBeTruthy();

    call.mockResolvedValueOnce({
      ok: true,
      status: 200,
      body: {
        points: [
          { lat: 35.68, lng: 139.76, recordedAt: '2026-10-24T09:00:00Z' },
          { lat: 35.69, lng: 139.77, recordedAt: '2026-10-24T09:00:10Z' },
        ],
      },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Show trail' }));
    await waitFor(() => expect(screen.getByTestId('canvas').textContent).toContain('2 crumbs'));
    expect(call).toHaveBeenCalledWith('GET', `tracking/admin/deliveries/${DELIVERY}/trail`);

    call.mockResolvedValueOnce({
      ok: true,
      status: 200,
      body: {
        couriers: [
          {
            courierId: COURIER,
            lat: 1,
            lng: 2,
            accuracyM: 5,
            recordedAt: '2026-10-24T09:00:00Z',
            distanceM: 1530,
          },
        ],
      },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Nearest couriers to pickup' }));
    await waitFor(() => expect(screen.getByText('1.5 km')).toBeTruthy());
    expect(call).toHaveBeenLastCalledWith(
      'GET',
      'tracking/admin/couriers/nearest?lat=35.6812&lng=139.7671&radiusM=10000&limit=5',
    );
  });

  it('says so when a read fails', async () => {
    show();
    fireEvent.click(screen.getByRole('button', { name: 'ORD-100' }));
    call.mockResolvedValueOnce({ ok: false, failure: { status: 403, code: 'access.denied' } });
    fireEvent.click(screen.getByRole('button', { name: 'Show trail' }));
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain('could not be loaded'),
    );
  });

  it('works without a base map, and says the feed stopped when the API ends it', () => {
    show({ styleUrl: null });
    expect(screen.queryByTestId('canvas')).toBeNull();
    expect(screen.getByText(/base map is not set up/)).toBeTruthy();
    act(() => streams[0]?.options.onState('ended'));
    expect(screen.getByText('Stopped')).toBeTruthy();
    expect(screen.getByText(/Reload the page/)).toBeTruthy();
  });
});
