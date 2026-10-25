import type { MapStyleElement } from 'react-native-maps';

/** Google Maps at night, in the dark palette's greens and greys (Android; iOS follows the phone). */
export const darkMapStyle: MapStyleElement[] = [
  { elementType: 'geometry', stylers: [{ color: '#141a17' }] },
  { elementType: 'labels.text.fill', stylers: [{ color: '#93a69d' }] },
  { elementType: 'labels.text.stroke', stylers: [{ color: '#0e1311' }] },
  { featureType: 'poi', elementType: 'labels', stylers: [{ visibility: 'off' }] },
  { featureType: 'poi.park', elementType: 'geometry', stylers: [{ color: '#13241c' }] },
  { featureType: 'road', elementType: 'geometry', stylers: [{ color: '#26302b' }] },
  { featureType: 'road.highway', elementType: 'geometry', stylers: [{ color: '#33403a' }] },
  { featureType: 'transit', stylers: [{ visibility: 'off' }] },
  { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#0f2433' }] },
];
