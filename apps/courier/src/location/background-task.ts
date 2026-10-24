import { ApiError, type CourierApi } from '../api/client';
import type { CourierSession } from '../api/schemas';
import { toPings, type LocationFix } from './pings';

export const LOCATION_TASK = 'mondapac-courier-location';

export interface TaskBody {
  readonly data?: unknown;
  readonly error?: { readonly message: string } | null;
}

export interface TaskDeps {
  readonly api: () => CourierApi;
  /** The session in memory, or the stored one when the OS started the task without the app. */
  readonly session: () => Promise<CourierSession | null>;
  readonly isOnline: () => Promise<boolean>;
  readonly stopUpdates: () => Promise<void>;
  /** Forgets a session the server no longer accepts. */
  readonly clearSession: () => Promise<void>;
}

/**
 * Handles one batch of background fixes: sends them to tracking only while the courier is
 * online and signed in, and stops the updates otherwise. Coordinates are never logged.
 */
export async function handleLocationUpdate(body: TaskBody, deps: TaskDeps): Promise<void> {
  if (body.error) return;
  const [online, session] = await Promise.all([deps.isOnline(), deps.session()]);
  if (!online || !session) {
    await deps.stopUpdates();
    return;
  }
  const fixes = (body.data as { locations?: LocationFix[] } | undefined)?.locations ?? [];
  const pings = toPings(fixes);
  if (pings.length === 0) return;
  try {
    await deps.api().sendPings(pings);
  } catch (error) {
    // A session the server rejects never sends again: stop collecting and forget it. Any other
    // lost batch is replaced by the next one; the latest position is what tracking keeps.
    if (error instanceof ApiError && error.status === 401) {
      await deps.stopUpdates();
      await deps.clearSession();
    }
  }
}
