import { describe, expect, it, vi } from 'vitest';
import {
  backoffDelay,
  checkStream,
  MapStream,
  streamUrl,
  type EventSourceLike,
  type StreamCheck,
  type StreamState,
} from './map-stream.ts';

class FakeSource implements EventSourceLike {
  readonly listeners = new Map<string, (event: MessageEvent<string>) => void>();
  onerror: ((event: Event) => void) | null = null;
  closed = false;
  constructor(readonly url: string) {}
  addEventListener(type: string, listener: (event: MessageEvent<string>) => void) {
    this.listeners.set(type, listener);
  }
  emit(type: string, data: string) {
    this.listeners.get(type)?.({ data } as MessageEvent<string>);
  }
  fail() {
    this.onerror?.(new Event('error'));
  }
  close() {
    this.closed = true;
  }
}

function harness(check: StreamCheck = { kind: 'retry' }) {
  const sources: FakeSource[] = [];
  const timers: { run: () => void; ms: number }[] = [];
  const states: StreamState[] = [];
  const onCouriers = vi.fn();
  const stream = new MapStream({
    onCouriers,
    onState: (state) => states.push(state),
    open: (url) => {
      const source = new FakeSource(url);
      sources.push(source);
      return source;
    },
    check: () => Promise.resolve(check),
    setTimer: (run, ms) => {
      timers.push({ run, ms });
      return timers.length;
    },
    clearTimer: () => undefined,
  });
  return { stream, sources, timers, states, onCouriers };
}

const query = { center: { lat: -27.46981, lng: 153.02512 }, radiusM: 8000.4, limit: 50 };
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('map stream', () => {
  it('asks the relay for the circle with 4 decimals and whole metres', () => {
    expect(streamUrl(query)).toBe(
      '/api/tracking/admin/map/stream?lat=-27.4698&lng=153.0251&radiusM=8000&limit=50',
    );
  });

  it('backs off from one second, doubling, up to thirty', () => {
    expect([0, 1, 2, 3, 4, 5, 6].map(backoffDelay)).toEqual([
      1000, 2000, 4000, 8000, 16000, 30000, 30000,
    ]);
  });

  it('hands the couriers of each event over and goes live', () => {
    const { stream, sources, states, onCouriers } = harness();
    stream.start(query);
    sources[0]?.emit('couriers', '{"couriers":[{"courierId":"c1"}]}');
    sources[0]?.emit('couriers', 'not json');
    expect(onCouriers).toHaveBeenCalledTimes(1);
    expect(onCouriers).toHaveBeenCalledWith([{ courierId: 'c1' }]);
    expect(states).toEqual(['connecting', 'live']);
  });

  it('reconnects after a failure with a growing delay, reset by the next event', async () => {
    const { stream, sources, timers, states } = harness();
    stream.start(query);
    sources[0]?.fail();
    await flush();
    expect(sources[0]?.closed).toBe(true);
    expect(timers.map((timer) => timer.ms)).toEqual([1000]);
    timers[0]?.run();
    sources[1]?.fail();
    await flush();
    expect(timers.map((timer) => timer.ms)).toEqual([1000, 2000]);
    timers[1]?.run();
    sources[2]?.emit('couriers', '{"couriers":[]}');
    sources[2]?.fail();
    await flush();
    expect(timers.map((timer) => timer.ms)).toEqual([1000, 2000, 1000]);
    expect(states).toContain('reconnecting');
    expect(sources).toHaveLength(3);
  });

  it('stops for good when the API ends the stream (a revoked role)', () => {
    const { stream, sources, timers, states } = harness();
    stream.start(query);
    sources[0]?.emit('end', '{"code":"access.denied"}');
    expect(sources[0]?.closed).toBe(true);
    expect(timers).toEqual([]);
    expect(states.at(-1)).toBe('ended');
  });

  it('stops and reports a signed-out admin instead of retrying', async () => {
    const { stream, sources, timers, states } = harness({ kind: 'signed-out' });
    stream.start(query);
    sources[0]?.fail();
    await flush();
    expect(timers).toEqual([]);
    expect(states.at(-1)).toBe('signed-out');
  });

  it('waits as long as the API asks after a 429, more than the backoff', async () => {
    const { stream, sources, timers } = harness({ kind: 'retry', notBeforeMs: 60_000 });
    stream.start(query);
    sources[0]?.fail();
    await flush();
    expect(timers.map((timer) => timer.ms)).toEqual([60_000]);
  });

  it('closes the old stream before opening one for a new circle, and ignores its late events', () => {
    const { stream, sources, onCouriers } = harness();
    stream.start(query);
    stream.start({ ...query, radiusM: 2000 });
    expect(sources[0]?.closed).toBe(true);
    sources[0]?.emit('couriers', '{"couriers":[]}');
    expect(onCouriers).not.toHaveBeenCalled();
    expect(sources[1]?.url).toContain('radiusM=2000');
  });
});

describe('stream check after a failure', () => {
  const url = '/api/tracking/admin/map/stream?lat=1&lng=2&radiusM=1000&limit=50';
  const answer = (response: Response) => {
    const fetchMock = vi.fn<typeof fetch>(() => Promise.resolve(response));
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  };

  it('reads a 401 as signed out', async () => {
    answer(new Response(null, { status: 401 }));
    expect(await checkStream(url)).toEqual({ kind: 'signed-out' });
  });

  it('reads the wait of a 429 from its body, capped at five minutes', async () => {
    const body = (seconds: number) =>
      JSON.stringify({
        code: 'tracking.too-many-streams',
        details: { retryAfterSeconds: seconds },
      });
    answer(new Response(body(60), { status: 429 }));
    expect(await checkStream(url)).toEqual({ kind: 'retry', notBeforeMs: 60_000 });
    answer(new Response(body(9999), { status: 429 }));
    expect(await checkStream(url)).toEqual({ kind: 'retry', notBeforeMs: 300_000 });
  });

  it('cancels an answer that opened a stream, so the slot is freed', async () => {
    const fetchMock = answer(
      new Response('', { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    );
    expect(await checkStream(url)).toEqual({ kind: 'retry' });
    expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });

  it('retries when the check itself fails', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new Error('offline')));
    expect(await checkStream(url)).toEqual({ kind: 'retry' });
    vi.unstubAllGlobals();
  });
});
