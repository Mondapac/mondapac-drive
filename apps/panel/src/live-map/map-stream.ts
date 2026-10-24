// The live map's channel: the API's `couriers` events through the panel relay, reconnected with
// backoff. An EventSource cannot read an HTTP status, so after a failure the stream asks the
// same URL once with fetch: a signed-out admin (401) is sent to sign in instead of retrying for
// ever, and a 429 (more than three open maps) waits as long as the API asks.

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
  /** What the stream URL answers now; any failure of the check itself is a plain retry. */
  readonly check?: (url: string) => Promise<StreamCheck>;
  readonly setTimer?: (run: () => void, ms: number) => unknown;
  readonly clearTimer?: (timer: unknown) => void;
}

export type StreamCheck =
  { readonly kind: 'signed-out' } | { readonly kind: 'retry'; readonly notBeforeMs?: number };

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

/**
 * Asks the stream URL once and reads only the status: an open stream is cancelled at once, so it
 * frees its slot; a refusal is a small JSON body.
 */
export async function checkStream(url: string): Promise<StreamCheck> {
  const abort = new AbortController();
  try {
    const response = await fetch(url, {
      headers: { accept: 'text/event-stream' },
      credentials: 'same-origin',
      cache: 'no-store',
      signal: abort.signal,
    });
    if (response.status === 401) return { kind: 'signed-out' };
    if (response.status === 429) {
      const body = (await response.json().catch((): unknown => null)) as {
        details?: { retryAfterSeconds?: unknown };
      } | null;
      const seconds = Number(
        response.headers.get('retry-after') ?? body?.details?.retryAfterSeconds,
      );
      return Number.isFinite(seconds) && seconds > 0
        ? { kind: 'retry', notBeforeMs: Math.min(seconds, 300) * 1000 }
        : { kind: 'retry' };
    }
    return { kind: 'retry' };
  } catch {
    return { kind: 'retry' };
  } finally {
    abort.abort();
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
      check: checkStream,
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
    const query = this.#query;
    const check: StreamCheck =
      query === null ? { kind: 'retry' } : await this.#options.check(streamUrl(query));
    if (generation !== this.#generation) return;
    if (check.kind === 'signed-out') {
      this.stop();
      this.#options.onState('signed-out');
      return;
    }
    const delay = Math.max(backoffDelay(this.#attempt), check.notBeforeMs ?? 0);
    this.#attempt += 1;
    this.#timer = this.#options.setTimer(() => {
      this.#timer = null;
      if (generation === this.#generation) this.#connect('reconnecting');
    }, delay);
  }
}
