// The live map's channel: the API's `couriers` events through the panel relay, reconnected with
// backoff. An EventSource cannot read an HTTP status, so after a failure the stream asks the
// session route once: a signed-out admin is sent to sign in instead of retrying for ever.

import type { GeoPoint } from '../ops/types.ts';
import type { NearbyCourier } from './model.ts';

export type StreamState = 'connecting' | 'live' | 'reconnecting' | 'ended' | 'signed-out';

export interface StreamQuery {
  readonly center: GeoPoint;
  readonly radiusM: number;
  readonly limit: number;
}

/** The part of `EventSource` the stream uses, so tests drive it without a server. */
export interface EventSourceLike {
  addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void;
  onerror: ((event: Event) => void) | null;
  close(): void;
}

export interface MapStreamOptions {
  readonly onCouriers: (couriers: readonly NearbyCourier[]) => void;
  readonly onState: (state: StreamState) => void;
  readonly open?: (url: string) => EventSourceLike;
  /** False when the session is gone (401); true otherwise, also when the check itself fails. */
  readonly signedIn?: () => Promise<boolean>;
  readonly setTimer?: (run: () => void, ms: number) => unknown;
  readonly clearTimer?: (timer: unknown) => void;
}

/** First retry after one second, doubling up to thirty. */
export const BACKOFF_MS = { first: 1000, max: 30_000 } as const;

export function backoffDelay(attempt: number): number {
  return Math.min(BACKOFF_MS.max, BACKOFF_MS.first * 2 ** attempt);
}

export function streamUrl(query: StreamQuery): string {
  const params = new URLSearchParams({
    lat: query.center.lat.toFixed(4),
    lng: query.center.lng.toFixed(4),
    radiusM: String(Math.round(query.radiusM)),
    limit: String(query.limit),
  });
  return `/api/tracking/admin/map/stream?${params.toString()}`;
}

async function sessionAlive(): Promise<boolean> {
  try {
    const response = await fetch('/api/identity/admin/session', {
      headers: { accept: 'application/json' },
      credentials: 'same-origin',
      cache: 'no-store',
    });
    return response.status !== 401;
  } catch {
    return true;
  }
}

function couriersOf(data: string): readonly NearbyCourier[] | null {
  try {
    const parsed = JSON.parse(data) as { couriers?: unknown };
    return Array.isArray(parsed.couriers) ? (parsed.couriers as NearbyCourier[]) : null;
  } catch {
    return null;
  }
}

export class MapStream {
  readonly #options: Required<MapStreamOptions>;
  #source: EventSourceLike | null = null;
  #timer: unknown = null;
  #attempt = 0;
  #query: StreamQuery | null = null;
  /** Bumped on every start and stop, so a late callback of an old source does nothing. */
  #generation = 0;

  constructor(options: MapStreamOptions) {
    this.#options = {
      open: (url) => new EventSource(url, { withCredentials: true }),
      signedIn: sessionAlive,
      setTimer: (run, ms) => setTimeout(run, ms),
      clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
      ...options,
    };
  }

  /** Opens the stream for a circle, closing any earlier one first (three streams per admin). */
  start(query: StreamQuery): void {
    this.stop();
    this.#query = query;
    this.#attempt = 0;
    this.#connect('connecting');
  }

  stop(): void {
    this.#generation += 1;
    this.#source?.close();
    this.#source = null;
    if (this.#timer !== null) this.#options.clearTimer(this.#timer);
    this.#timer = null;
  }

  #connect(state: StreamState): void {
    const query = this.#query;
    if (query === null) return;
    const generation = this.#generation;
    this.#options.onState(state);
    const source = this.#options.open(streamUrl(query));
    this.#source = source;
    source.addEventListener('couriers', (event) => {
      if (generation !== this.#generation) return;
      const couriers = couriersOf(event.data);
      if (couriers === null) return;
      this.#attempt = 0;
      this.#options.onState('live');
      this.#options.onCouriers(couriers);
    });
    // The gate refused a tick (a revoked role or session): the API closes, so do not retry.
    source.addEventListener('end', () => {
      if (generation !== this.#generation) return;
      this.stop();
      this.#options.onState('ended');
    });
    source.onerror = () => {
      if (generation !== this.#generation) return;
      source.close();
      this.#source = null;
      void this.#retry(generation);
    };
  }

  async #retry(generation: number): Promise<void> {
    this.#options.onState('reconnecting');
    if (!(await this.#options.signedIn())) {
      if (generation !== this.#generation) return;
      this.stop();
      this.#options.onState('signed-out');
      return;
    }
    if (generation !== this.#generation) return;
    const delay = backoffDelay(this.#attempt);
    this.#attempt += 1;
    this.#timer = this.#options.setTimer(() => {
      this.#timer = null;
      if (generation === this.#generation) this.#connect('reconnecting');
    }, delay);
  }
}
