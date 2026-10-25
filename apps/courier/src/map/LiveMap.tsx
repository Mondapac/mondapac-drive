import { useEffect, useRef } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import MapView, { Marker, PROVIDER_GOOGLE, type LatLng } from 'react-native-maps';
import type { GeoPoint } from '../api/schemas';
import { makeStyles, radius, useTheme } from '../ui/theme';
import { darkMapStyle } from './dark-style';
import { mapsAvailable } from './map-support';

export interface MapStop {
  readonly kind: 'pickup' | 'dropoff';
  readonly point: GeoPoint;
  /** Read out by a screen reader and shown when the pin is tapped. */
  readonly label: string;
}

interface Props {
  /** The stops to frame together with the courier; none frames the courier alone. */
  readonly stops?: readonly MapStop[];
  readonly height: number;
  /** Read out for the map as a whole. */
  readonly label: string;
}

const EDGE = { top: 48, right: 48, bottom: 48, left: 48 };
/** Roughly a suburb across, for the courier alone. */
const NEARBY = { latitudeDelta: 0.03, longitudeDelta: 0.03 };

const toLatLng = (point: GeoPoint): LatLng => ({ latitude: point.lat, longitude: point.lng });

/**
 * The live map: the courier's own position (the phone draws it from its location, nothing is sent)
 * and the stops of the offer or job. Nothing at all where the build has no map (see
 * `mapsAvailable`), so the screen reads the same without it.
 */
export function LiveMap({ stops = [], height, label }: Props) {
  const styles = useStyles();
  const palette = useTheme();
  const map = useRef<MapView>(null);
  const courier = useRef<LatLng | null>(null);
  const key = stops.map((stop) => `${stop.point.lat},${stop.point.lng}`).join('|');

  const frame = () => {
    const coordinates = stops.map((stop) => toLatLng(stop.point));
    if (courier.current) coordinates.push(courier.current);
    if (coordinates.length > 1) {
      map.current?.fitToCoordinates(coordinates, { edgePadding: EDGE, animated: true });
    } else if (coordinates[0]) {
      map.current?.animateToRegion({ ...coordinates[0], ...NEARBY }, 300);
    }
  };

  // The stops changed (a new offer, the next leg): frame them again.
  useEffect(frame, [key]);

  if (!mapsAvailable()) return null;
  const dark = palette.scheme === 'dark';
  return (
    <View style={[styles.frame, { height }]} accessible accessibilityLabel={label}>
      <MapView
        ref={map}
        style={StyleSheet.absoluteFill}
        // Android draws Google Maps; iOS keeps its default, Apple Maps.
        {...(Platform.OS === 'android' ? { provider: PROVIDER_GOOGLE } : {})}
        userInterfaceStyle={dark ? 'dark' : 'light'}
        customMapStyle={dark ? darkMapStyle : []}
        showsUserLocation
        showsMyLocationButton={false}
        showsPointsOfInterests={false}
        toolbarEnabled={false}
        pitchEnabled={false}
        rotateEnabled={false}
        onMapReady={frame}
        onUserLocationChange={(event) => {
          const position = event.nativeEvent.coordinate;
          if (!position) return;
          const first = courier.current === null;
          courier.current = { latitude: position.latitude, longitude: position.longitude };
          // The first fix frames the map; later ones leave the courier's own panning alone.
          if (first) frame();
        }}
      >
        {stops.map((stop) => (
          <Marker
            key={`${stop.kind}:${stop.point.lat},${stop.point.lng}`}
            coordinate={toLatLng(stop.point)}
            title={stop.label}
            pinColor={stop.kind === 'pickup' ? palette.text : palette.primary}
          />
        ))}
      </MapView>
    </View>
  );
}

const useStyles = makeStyles((c) =>
  StyleSheet.create({
    frame: { borderRadius: radius.lg, overflow: 'hidden', backgroundColor: c.raised },
  }),
);
