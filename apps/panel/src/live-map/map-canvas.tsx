'use client';

import 'maplibre-gl/dist/maplibre-gl.css';
import { useEffect, useRef, useState } from 'react';
import type { GeoJSONSource, Map as MapLibreMap } from 'maplibre-gl';
import type { GeoPoint } from '../ops/types.ts';
import { pinPoint, type MapDelivery, type NearbyCourier, type TrailPoint } from './model.ts';

export interface MapCanvasProps {
  readonly styleUrl: string;
  readonly center: GeoPoint;
  readonly zoom: number;
  readonly label: string;
  readonly couriers: readonly NearbyCourier[];
  readonly deliveries: readonly MapDelivery[];
  readonly selectedId: string | null;
  readonly trail: readonly TrailPoint[];
  readonly onSelect: (deliveryId: string) => void;
  /** The view's center and one corner, after the admin pans or zooms. */
  readonly onView: (center: GeoPoint, corner: GeoPoint) => void;
}

// The GeoJSON shapes the map's sources take, written out so no @types/geojson is needed.
type Geometry =
  | { readonly type: 'Point'; readonly coordinates: [number, number] }
  | { readonly type: 'LineString'; readonly coordinates: [number, number][] };
interface Feature {
  readonly type: 'Feature';
  readonly geometry: Geometry;
  readonly properties: Record<string, string | number | boolean>;
}
const collection = (features: Feature[]) => ({
  type: 'FeatureCollection' as const,
  features,
});
const point = (at: GeoPoint, properties: Record<string, string | number | boolean>): Feature => ({
  type: 'Feature',
  geometry: { type: 'Point', coordinates: [at.lng, at.lat] },
  properties,
});

/**
 * A colour of the design tokens (ADR-0033), read from the page so the map follows light and dark
 * mode. The panel stylesheet always defines them; grey only stands in if one is missing.
 */
function token(name: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value === '' ? 'gray' : value;
}

/**
 * The MapLibre map: couriers as dots, delivery pins (red for an exception), the selected
 * delivery's two stops and its trail. MapLibre loads in the browser only, after mount. Nothing
 * here logs or reports a coordinate.
 */
export function MapCanvas(props: MapCanvasProps) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<MapLibreMap | null>(null);
  const [ready, setReady] = useState(false);
  const latest = useRef(props);
  latest.current = props;

  useEffect(() => {
    let cancelled = false;
    let created: MapLibreMap | null = null;
    void import('maplibre-gl').then(({ Map: MapLibre, getVersion, setWorkerUrl }) => {
      if (cancelled || container.current === null) return;
      // Served unchanged by the panel (scripts/copy-maplibre-worker.mjs): same origin, no blob.
      setWorkerUrl(`/maplibre/${getVersion()}/maplibre-gl-worker.mjs`);
      const { styleUrl, center, zoom } = latest.current;
      created = new MapLibre({
        container: container.current,
        style: styleUrl,
        center: [center.lng, center.lat],
        zoom,
        attributionControl: { compact: true },
      });
      map.current = created;
      const instance = created;
      instance.on('load', () => {
        const accent = token('--color-accent');
        const critical = token('--color-critical-fg');
        const info = token('--color-fg-muted');
        const surface = token('--color-surface');
        for (const id of ['trail', 'stops', 'deliveries', 'couriers']) {
          instance.addSource(id, { type: 'geojson', data: collection([]) });
        }
        instance.addLayer({
          id: 'trail',
          type: 'line',
          source: 'trail',
          paint: { 'line-color': accent, 'line-width': 3, 'line-opacity': 0.8 },
        });
        instance.addLayer({
          id: 'stops',
          type: 'circle',
          source: 'stops',
          paint: {
            'circle-radius': 6,
            'circle-color': surface,
            'circle-stroke-color': accent,
            'circle-stroke-width': 3,
          },
        });
        instance.addLayer({
          id: 'deliveries',
          type: 'circle',
          source: 'deliveries',
          paint: {
            'circle-radius': ['case', ['get', 'selected'], 9, 7],
            'circle-color': ['case', ['get', 'exception'], critical, info],
            'circle-stroke-color': surface,
            'circle-stroke-width': 2,
          },
        });
        instance.addLayer({
          id: 'couriers',
          type: 'circle',
          source: 'couriers',
          paint: {
            'circle-radius': 6,
            'circle-color': accent,
            'circle-stroke-color': surface,
            'circle-stroke-width': 2,
          },
        });
        instance.on('click', 'deliveries', (event) => {
          const id: unknown = event.features?.[0]?.properties['id'];
          if (typeof id === 'string') latest.current.onSelect(id);
        });
        instance.on('mouseenter', 'deliveries', () => {
          instance.getCanvas().style.cursor = 'pointer';
        });
        instance.on('mouseleave', 'deliveries', () => {
          instance.getCanvas().style.cursor = '';
        });
        setReady(true);
      });
      instance.on('moveend', () => {
        const middle = instance.getCenter();
        const corner = instance.getBounds().getNorthEast();
        latest.current.onView(
          { lat: middle.lat, lng: middle.lng },
          { lat: corner.lat, lng: corner.lng },
        );
      });
    });
    return () => {
      cancelled = true;
      created?.remove();
      map.current = null;
    };
  }, []);

  const { couriers, deliveries, selectedId, trail } = props;

  useEffect(() => {
    if (!ready) return;
    void map.current
      ?.getSource<GeoJSONSource>('couriers')
      ?.setData(collection(couriers.map((courier) => point(courier, { id: courier.courierId }))));
  }, [ready, couriers]);

  useEffect(() => {
    if (!ready) return;
    const pins: Feature[] = [];
    for (const delivery of deliveries) {
      const at = pinPoint(delivery);
      if (at === null) continue;
      pins.push(
        point(at, {
          id: delivery.id,
          exception: delivery.exception !== null,
          selected: delivery.id === selectedId,
        }),
      );
    }
    void map.current?.getSource<GeoJSONSource>('deliveries')?.setData(collection(pins));
    const selected = deliveries.find((delivery) => delivery.id === selectedId);
    const stops = [selected?.pickup, selected?.dropoff].filter(
      (stop): stop is GeoPoint => stop !== null && stop !== undefined,
    );
    void map.current
      ?.getSource<GeoJSONSource>('stops')
      ?.setData(collection(stops.map((stop) => point(stop, {}))));
  }, [ready, deliveries, selectedId]);

  useEffect(() => {
    if (!ready) return;
    const line: Feature[] =
      trail.length < 2
        ? []
        : [
            {
              type: 'Feature',
              geometry: {
                type: 'LineString',
                coordinates: trail.map((crumb) => [crumb.lng, crumb.lat]),
              },
              properties: {},
            },
          ];
    void map.current?.getSource<GeoJSONSource>('trail')?.setData(collection(line));
  }, [ready, trail]);

  return (
    <div
      ref={container}
      role="region"
      aria-label={props.label}
      className="h-[60vh] min-h-80 w-full overflow-hidden rounded-lg border border-line bg-muted"
    />
  );
}
