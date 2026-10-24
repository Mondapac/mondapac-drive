import * as TaskManager from 'expo-task-manager';
import { courierApi } from '../api';
import {
  clearSession,
  isOnlineFlagSet,
  loadSession,
  sessionSource,
} from '../session/session-store';
import { handleLocationUpdate, LOCATION_TASK, type TaskBody } from './background-task';
import { stopTracking } from './tracking';

// The task is defined when this module loads, at the top of the app (expo-task-manager needs
// it in the global scope, also when the OS starts the app in the background).
TaskManager.defineTask<unknown>(LOCATION_TASK, (body: TaskBody) =>
  handleLocationUpdate(body, {
    api: courierApi,
    session: async () => sessionSource.current() ?? (await loadSession()),
    isOnline: isOnlineFlagSet,
    stopUpdates: stopTracking,
    clearSession,
  }),
);
