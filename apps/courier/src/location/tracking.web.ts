import type { LocationAccess } from './tracking';

/**
 * Web is a developer preview of the screens only: there is no background location in a
 * browser, so going online there shares nothing.
 */
export function locationAccess(): Promise<LocationAccess> {
  return Promise.resolve('granted');
}

export function requestLocationAccess(): Promise<LocationAccess> {
  return Promise.resolve('granted');
}

export function openAppSettings(): Promise<void> {
  return Promise.resolve();
}

export function startTracking(): Promise<void> {
  return Promise.resolve();
}

export function stopTracking(): Promise<void> {
  return Promise.resolve();
}
