'use client';

import { Badge, Banner, Button, Card } from '@mondapac-drive/ui';
import { useFormatter, useTranslations } from 'next-intl';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { callApi } from '../api/client.ts';
import type { GeoPoint } from '../ops/types.ts';
import { shortId } from '../shared/short-id.ts';
import { MapCanvas } from './map-canvas.tsx';
import { MapStream, type StreamState } from './map-stream.ts';
import {
  exceptionsOf,
  pinPoint,
  viewCircle,
  type MapDelivery,
  type NearbyCourier,
  type TrailPoint,
} from './model.ts';

/** The widest circle the map asks for; the API caps it again by the Market's settings. */
const MAX_RADIUS_M = 20_000;
/** Couriers per stream event, and per nearest-couriers answer. */
const STREAM_LIMIT = 50;
const NEAREST_LIMIT = 5;
const NEAREST_RADIUS_M = 10_000;
/** A pan or zoom restarts the stream only after the view has settled. */
const VIEW_SETTLE_MS = 800;

export interface LiveMapProps {
  /** Null: no base map, the lists still work. */
  readonly styleUrl: string | null;
  readonly center: GeoPoint;
  readonly zoom: number;
  readonly deliveries: readonly MapDelivery[];
  /** Courier names the session may read, by account id; others show a short id. */
  readonly courierNames: Readonly<Record<string, string>>;
}

const STATE_TONE = {
  connecting: 'neutral',
  live: 'success',
  reconnecting: 'attention',
  ended: 'critical',
  'signed-out': 'critical',
} as const;

/**
 * The dispatcher's live map: couriers from the map stream, the deliveries on their way, the
 * exceptions to act on, and for one delivery its trail and the couriers nearest its pickup.
 */
export function LiveMap({ styleUrl, center, zoom, deliveries, courierNames }: LiveMapProps) {
  const t = useTranslations('live-map');
  const statusLabel = useTranslations('deliveries.status');
  const format = useFormatter();
  const [couriers, setCouriers] = useState<readonly NearbyCourier[]>([]);
  const [state, setState] = useState<StreamState>('connecting');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [trail, setTrail] = useState<readonly TrailPoint[] | null>(null);
  const [nearest, setNearest] = useState<readonly NearbyCourier[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const stream = useRef<MapStream | null>(null);
  const settle = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const live = new MapStream({
      onCouriers: setCouriers,
      onState: (next) => {
        setState(next);
        if (next === 'signed-out') window.location.assign('/session-ended');
      },
    });
    stream.current = live;
    live.start({ center, radiusM: MAX_RADIUS_M, limit: STREAM_LIMIT });
    return () => {
      live.stop();
      if (settle.current !== null) clearTimeout(settle.current);
    };
  }, [center]);

  const onView = useCallback((middle: GeoPoint, corner: GeoPoint) => {
    if (settle.current !== null) clearTimeout(settle.current);
    settle.current = setTimeout(() => {
      const circle = viewCircle(middle, corner, MAX_RADIUS_M);
      stream.current?.start({ ...circle, limit: STREAM_LIMIT });
    }, VIEW_SETTLE_MS);
  }, []);

  const select = useCallback((id: string) => {
    setSelectedId(id);
    setTrail(null);
    setNearest(null);
    setProblem(null);
  }, []);

  const selected = deliveries.find((delivery) => delivery.id === selectedId) ?? null;
  const exceptions = useMemo(() => exceptionsOf(deliveries), [deliveries]);
  const nameOf = (courierId: string) => courierNames[courierId] ?? shortId(courierId);

  async function showTrail(delivery: MapDelivery): Promise<void> {
    setProblem(null);
    const result = await callApi<{ readonly points: readonly TrailPoint[] }>(
      'GET',
      `tracking/admin/deliveries/${delivery.id}/trail`,
    );
    if (result.ok) setTrail(result.body.points);
    else setProblem(t('load-failed'));
  }

  async function findNearest(at: GeoPoint): Promise<void> {
    setProblem(null);
    const query = new URLSearchParams({
      lat: at.lat.toFixed(4),
      lng: at.lng.toFixed(4),
      radiusM: String(NEAREST_RADIUS_M),
      limit: String(NEAREST_LIMIT),
    });
    const result = await callApi<{ readonly couriers: readonly NearbyCourier[] }>(
      'GET',
      `tracking/admin/couriers/nearest?${query.toString()}`,
    );
    if (result.ok) setNearest(result.body.couriers);
    else setProblem(t('load-failed'));
  }

  const km = (metres: number) =>
    t('distance', { km: format.number(metres / 1000, { maximumFractionDigits: 1 }) });
  const at = (iso: string) => format.dateTime(new Date(iso), { timeStyle: 'medium' });

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,24rem)]">
      <div className="flex min-w-0 flex-col gap-3">
        <p className="flex flex-wrap items-center gap-2" aria-live="polite">
          <Badge tone={STATE_TONE[state]}>{t(`stream.${state}`)}</Badge>
          {state === 'ended' ? (
            <span className="text-fg-muted">{t('stream.ended-help')}</span>
          ) : null}
        </p>
        {styleUrl === null ? (
          <Banner tone="info">{t('no-base-map')}</Banner>
        ) : (
          <MapCanvas
            styleUrl={styleUrl}
            center={center}
            zoom={zoom}
            label={t('map-label')}
            couriers={couriers}
            deliveries={deliveries}
            selectedId={selectedId}
            trail={trail ?? []}
            onSelect={select}
            onView={onView}
          />
        )}
        <Card title={t('couriers.title', { count: couriers.length })}>
          {couriers.length === 0 ? (
            <p className="text-fg-muted">{t('couriers.empty')}</p>
          ) : (
            <ul className="flex flex-col divide-y divide-line">
              {couriers.map((courier) => (
                <li key={courier.courierId} className="flex flex-wrap justify-between gap-2 py-2">
                  <span className="font-medium">{nameOf(courier.courierId)}</span>
                  <span className="text-fg-muted">
                    {t('couriers.updated', { time: at(courier.recordedAt) })}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
      <div className="flex min-w-0 flex-col gap-4">
        {problem === null ? null : <Banner tone="critical">{problem}</Banner>}
        {selected === null ? null : (
          <Card title={t('selected.title', { reference: selected.reference })}>
            <p className="flex flex-wrap gap-2">
              <Badge tone="info">{statusLabel(selected.status)}</Badge>
              {selected.exception === null ? null : (
                <Badge tone="critical">{t(`exception.${selected.exception}`)}</Badge>
              )}
            </p>
            <p>
              {selected.courierId === null
                ? t('selected.no-courier')
                : t('selected.courier', { name: nameOf(selected.courierId) })}
            </p>
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" onClick={() => void showTrail(selected)}>
                {t('selected.show-trail')}
              </Button>
              {selected.pickup === null ? null : (
                <Button
                  variant="secondary"
                  onClick={() => void findNearest(selected.pickup as GeoPoint)}
                >
                  {t('selected.nearest')}
                </Button>
              )}
            </div>
            {trail !== null && trail.length === 0 ? (
              <p className="text-fg-muted">{t('selected.trail-empty')}</p>
            ) : null}
            {trail !== null && trail.length > 0 && styleUrl === null ? (
              <p className="text-fg-muted">{t('selected.trail-points', { count: trail.length })}</p>
            ) : null}
            {nearest === null ? null : nearest.length === 0 ? (
              <p className="text-fg-muted">{t('selected.nearest-empty')}</p>
            ) : (
              <ol className="flex flex-col divide-y divide-line">
                {nearest.map((courier) => (
                  <li key={courier.courierId} className="flex justify-between gap-2 py-2">
                    <span className="font-medium">{nameOf(courier.courierId)}</span>
                    <span className="text-fg-muted">{km(courier.distanceM)}</span>
                  </li>
                ))}
              </ol>
            )}
            <a
              className="inline-flex min-h-12 items-center font-medium text-link underline"
              href={`/deliveries/${selected.id}`}
            >
              {t('open-dispatch')}
            </a>
          </Card>
        )}
        <Card title={t('exceptions.title', { count: exceptions.length })}>
          {exceptions.length === 0 ? (
            <p className="text-fg-muted">{t('exceptions.empty')}</p>
          ) : (
            <ul className="flex flex-col divide-y divide-line">
              {exceptions.map((delivery) => (
                <li key={delivery.id} className="flex flex-col gap-1 py-2">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="break-all font-medium">{delivery.reference}</span>
                    <Badge tone="critical">{t(`exception.${delivery.exception}`)}</Badge>
                  </span>
                  <span className="flex flex-wrap gap-4">
                    {pinPoint(delivery) === null ? null : (
                      <Button variant="link" onClick={() => select(delivery.id)}>
                        {t('show-on-map')}
                      </Button>
                    )}
                    <a
                      className="inline-flex min-h-12 items-center font-medium text-link underline"
                      href={`/deliveries/${delivery.id}`}
                    >
                      {t('open-dispatch')}
                    </a>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title={t('deliveries.title', { count: deliveries.length })}>
          {deliveries.length === 0 ? (
            <p className="text-fg-muted">{t('deliveries.empty')}</p>
          ) : (
            <ul className="flex flex-col divide-y divide-line">
              {deliveries.map((delivery) => (
                <li
                  key={delivery.id}
                  className="flex flex-wrap items-center justify-between gap-2 py-1"
                >
                  <Button
                    variant="link"
                    aria-pressed={delivery.id === selectedId}
                    onClick={() => select(delivery.id)}
                  >
                    <span className="break-all">{delivery.reference}</span>
                  </Button>
                  <span className="text-fg-muted">{statusLabel(delivery.status)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
