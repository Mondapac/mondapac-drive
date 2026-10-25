import type { PushDevice } from '../api/schemas';

/** The device's push notifications, behind a port: the app uses Expo's, tests a fake. */
export interface PushService {
  /** This device's Expo push token, asking the courier first; null when there is none. */
  deviceToken(): Promise<PushDevice | null>;
  /**
   * Calls `listener` with the offer id of each offer push that arrives while the app is open or
   * that the courier taps. Returns the unsubscribe function.
   */
  onOffer(listener: (offerId: string) => void): () => void;
}

/**
 * The offer id of a push's data (`{ kind: 'offer', offerId }`, notifications module), or null for
 * anything else. The push carries no address or recipient; the app fetches the offer itself.
 */
export function offerIdOf(data: unknown): string | null {
  if (typeof data !== 'object' || data === null) return null;
  const { kind, offerId } = data as { kind?: unknown; offerId?: unknown };
  return kind === 'offer' && typeof offerId === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(offerId)
    ? offerId
    : null;
}

/** A push can arrive twice (the sender retries); each offer is acted on once. */
export function onceEach(limit = 20): (id: string) => boolean {
  const seen: string[] = [];
  return (id) => {
    if (seen.includes(id)) return false;
    seen.push(id);
    if (seen.length > limit) seen.shift();
    return true;
  };
}
