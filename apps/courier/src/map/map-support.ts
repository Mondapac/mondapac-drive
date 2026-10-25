import Constants from 'expo-constants';
import { Platform } from 'react-native';

/**
 * Whether this build can show a map: Apple Maps on iOS needs nothing, Google Maps on Android needs
 * the key the build was given (app.config `extra.androidMaps`). Elsewhere (web) there is none.
 */
export function mapsAvailable(
  os: string = Platform.OS,
  extra: unknown = Constants.expoConfig?.extra,
): boolean {
  if (os === 'ios') return true;
  if (os !== 'android') return false;
  return (extra as { androidMaps?: unknown } | undefined)?.androidMaps === true;
}
