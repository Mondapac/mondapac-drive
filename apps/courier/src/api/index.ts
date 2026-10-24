import { env, type AppEnv } from '../platform/env';
import { systemClock, type Clock } from '../platform/clock/clock';
import { activeJobMemory, sessionSource } from '../session/session-store';
import type { CourierApi, SessionSource } from './client';
import { createHttpCourierApi } from './http-client';
import { createMockCourierApi } from './mock/mock-client';

export function createCourierApi(appEnv: AppEnv, session: SessionSource, clock: Clock): CourierApi {
  if (appEnv.apiMode === 'http' && appEnv.apiUrl && appEnv.marketId) {
    return createHttpCourierApi({
      baseUrl: appEnv.apiUrl,
      marketId: appEnv.marketId,
      session,
      activeJob: activeJobMemory,
    });
  }
  return createMockCourierApi({ clock }).api;
}

let shared: CourierApi | null = null;

/** The app's one API client; the background location task uses it too. */
export function courierApi(): CourierApi {
  shared ??= createCourierApi(env, sessionSource, systemClock);
  return shared;
}
