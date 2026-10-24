import * as Location from 'expo-location';
import { Linking } from 'react-native';
import { t } from '../i18n';
import { LOCATION_TASK } from './background-task';

export type LocationAccess = 'granted' | 'ask' | 'blocked';

/** Whether the courier can go online: foreground and background location are both needed. */
export async function locationAccess(): Promise<LocationAccess> {
  const foreground = await Location.getForegroundPermissionsAsync();
  const background = await Location.getBackgroundPermissionsAsync();
  if (foreground.granted && background.granted) return 'granted';
  const blocked =
    (!foreground.granted && !foreground.canAskAgain) ||
    (!background.granted && !background.canAskAgain);
  return blocked ? 'blocked' : 'ask';
}

/**
 * Asks for location in the order both platforms need: while-in-use first, then background
 * ("Allow all the time" on Android, "Always" on iOS). Called after the rationale screen.
 */
export async function requestLocationAccess(): Promise<LocationAccess> {
  const foreground = await Location.requestForegroundPermissionsAsync();
  if (!foreground.granted) return foreground.canAskAgain ? 'ask' : 'blocked';
  const background = await Location.requestBackgroundPermissionsAsync();
  if (!background.granted) return background.canAskAgain ? 'ask' : 'blocked';
  return 'granted';
}

export function openAppSettings(): Promise<void> {
  return Linking.openSettings();
}

/** Starts background updates; Android shows a notification for as long as they run. */
export async function startTracking(): Promise<void> {
  if (await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK)) return;
  await Location.startLocationUpdatesAsync(LOCATION_TASK, {
    accuracy: Location.Accuracy.High,
    timeInterval: 10_000,
    distanceInterval: 25,
    pausesUpdatesAutomatically: false,
    activityType: Location.ActivityType.OtherNavigation,
    showsBackgroundLocationIndicator: true,
    foregroundService: {
      notificationTitle: t('permissions.location.notificationTitle'),
      notificationBody: t('permissions.location.notificationBody'),
    },
  });
}

export async function stopTracking(): Promise<void> {
  if (await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK)) {
    await Location.stopLocationUpdatesAsync(LOCATION_TASK);
  }
}
