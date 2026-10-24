import { Logger } from '@nestjs/common';
import type { OutboxRelay, RelayPass } from '../events/event-bus';
import type { DispatchPass, EventDispatcher } from '../events/event-delivery';
import type { Scheduler } from '../scheduler/scheduler';
import { WorkerRuntime } from './worker-runtime';

/** A relay whose passes the test scripts; it counts them. */
function scriptedRelay(passes: (RelayPass | Error)[], unhosted: string[] = []) {
  let index = 0;
  const relay: OutboxRelay & { calls: number } = {
    calls: 0,
    runOnce() {
      relay.calls += 1;
      const next = passes[Math.min(index, passes.length - 1)]!;
      index += 1;
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
    },
    unhostedMarketsWithRows: () => Promise.resolve(unhosted),
  };
  return relay;
}

/** A scheduler that only records start() and stop(); the mocks are returned beside it. */
function fakeScheduler() {
  const start = jest.fn();
  const stop = jest.fn((graceMs: number) => {
    void graceMs;
    return Promise.resolve();
  });
  return { scheduler: { start, stop } as unknown as Scheduler, start, stop };
}

/** A dispatcher whose passes the test scripts; it counts them. */
function scriptedDispatcher(passes: (DispatchPass | Error)[]) {
  let index = 0;
  const dispatcher: EventDispatcher & { calls: number } = {
    calls: 0,
    runOnce() {
      dispatcher.calls += 1;
      const next = passes[Math.min(index, passes.length - 1)]!;
      index += 1;
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
    },
  };
  return dispatcher;
}

const idle: RelayPass = { published: 0, fullBatch: false };
const full: RelayPass = { published: 50, fullBatch: true };
const idlePass: DispatchPass = { claimed: 0, fullBatch: false };
const fullPass: DispatchPass = { claimed: 20, fullBatch: true };

describe('WorkerRuntime (platform persistence design 6.1 and 8)', () => {
  let errors: jest.SpyInstance;

  beforeEach(() => {
    jest.useFakeTimers();
    errors = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('starts nothing until start() is called', async () => {
    const relay = scriptedRelay([idle]);
    const { scheduler, start } = fakeScheduler();
    new WorkerRuntime(relay, scheduler, scriptedDispatcher([idlePass]));

    await jest.advanceTimersByTimeAsync(5000);

    expect(relay.calls).toBe(0);
    expect(start).not.toHaveBeenCalled();
  });

  it('pauses 500 ms after a pass without a full batch, and runs the next pass at once after a full one', async () => {
    const relay = scriptedRelay([full, full, idle, idle]);
    const runtime = new WorkerRuntime(
      relay,
      fakeScheduler().scheduler,
      scriptedDispatcher([idlePass]),
    );

    await runtime.start();
    await jest.advanceTimersByTimeAsync(0);
    expect(relay.calls).toBe(3); // full, full, idle: then the pause
    await jest.advanceTimersByTimeAsync(499);
    expect(relay.calls).toBe(3);
    await jest.advanceTimersByTimeAsync(1);
    expect(relay.calls).toBe(4);

    await runtime.stop();
  });

  it('logs a failed pass and repeats it after the pause', async () => {
    const relay = scriptedRelay([new Error('database gone'), idle]);
    const runtime = new WorkerRuntime(
      relay,
      fakeScheduler().scheduler,
      scriptedDispatcher([idlePass]),
    );

    await runtime.start();
    await jest.advanceTimersByTimeAsync(500);

    expect(relay.calls).toBe(2);
    expect(errors).toHaveBeenCalledWith(
      expect.objectContaining({ msg: 'outbox.relay-pass-failed' }),
    );
    await runtime.stop();
  });

  it('logs the Markets with unpublished rows that this stack does not host, once, at start', async () => {
    const runtime = new WorkerRuntime(
      scriptedRelay([idle], ['NZ']),
      fakeScheduler().scheduler,
      scriptedDispatcher([idlePass]),
    );

    await runtime.start();

    expect(errors).toHaveBeenCalledWith({ msg: 'outbox.unhosted-markets', marketIds: ['NZ'] });
    await runtime.stop();
  });

  it('starts the scheduler, and stop() ends the loop and stops the scheduler with the 10 s grace', async () => {
    const relay = scriptedRelay([idle]);
    const { scheduler, start, stop } = fakeScheduler();
    const runtime = new WorkerRuntime(relay, scheduler, scriptedDispatcher([idlePass]));

    await runtime.start();
    expect(start).toHaveBeenCalledTimes(1);
    await runtime.stop();
    const calls = relay.calls;
    await jest.advanceTimersByTimeAsync(10_000);

    expect(relay.calls).toBe(calls);
    expect(stop).toHaveBeenCalledWith(10_000);
  });

  it('runs the dispatcher loop beside the relay loop with the same pause rule (P 6.4)', async () => {
    const dispatcher = scriptedDispatcher([fullPass, idlePass, idlePass]);
    const runtime = new WorkerRuntime(scriptedRelay([idle]), fakeScheduler().scheduler, dispatcher);

    await runtime.start();
    await jest.advanceTimersByTimeAsync(0);
    expect(dispatcher.calls).toBe(2); // full, idle: then the pause
    await jest.advanceTimersByTimeAsync(500);
    expect(dispatcher.calls).toBe(3);

    await runtime.stop();
  });

  it('logs a failed dispatcher pass and repeats it after the pause; the relay keeps running', async () => {
    const relay = scriptedRelay([idle]);
    const dispatcher = scriptedDispatcher([new Error('database gone'), idlePass]);
    const runtime = new WorkerRuntime(relay, fakeScheduler().scheduler, dispatcher);

    await runtime.start();
    await jest.advanceTimersByTimeAsync(500);

    expect(dispatcher.calls).toBe(2);
    expect(relay.calls).toBe(2);
    expect(errors).toHaveBeenCalledWith(
      expect.objectContaining({ msg: 'event-delivery.pass-failed' }),
    );
    await runtime.stop();
  });

  it('stop() ends both loops', async () => {
    const relay = scriptedRelay([idle]);
    const dispatcher = scriptedDispatcher([idlePass]);
    const runtime = new WorkerRuntime(relay, fakeScheduler().scheduler, dispatcher);

    await runtime.start();
    await runtime.stop();
    const [relayCalls, dispatcherCalls] = [relay.calls, dispatcher.calls];
    await jest.advanceTimersByTimeAsync(5000);

    expect(relay.calls).toBe(relayCalls);
    expect(dispatcher.calls).toBe(dispatcherCalls);
  });

  it('logs a heartbeat line every minute (P 8, liveness)', async () => {
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const runtime = new WorkerRuntime(
      scriptedRelay([idle]),
      fakeScheduler().scheduler,
      scriptedDispatcher([idlePass]),
    );

    await runtime.start();
    log.mockClear();
    await jest.advanceTimersByTimeAsync(60_000);

    expect(log).toHaveBeenCalledWith({ msg: 'worker.heartbeat' });
    await runtime.stop();
  });
});
