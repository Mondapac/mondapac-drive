import { Logger } from '@nestjs/common';
import { RELAY_IDLE_PAUSE_MS, type OutboxRelay } from '../events/event-bus';
import type { EventDispatcher } from '../events/event-delivery';
import type { Scheduler } from '../scheduler/scheduler';

/** How long `stop()` waits for the pass and the job runs in flight (P 8). */
export const STOP_GRACE_MS = 10_000;
/** The worker's liveness line in Phase 2 (P 8, PK2). */
export const HEARTBEAT_MS = 60_000;

/** One pass of a loop: `fullBatch` means the next pass runs at once. */
type LoopPass = () => Promise<{ readonly fullBatch: boolean }>;

/**
 * What the `worker` role runs (platform persistence design, "P", 8; ADR-0006 decisions 4
 * and 7): the relay loop, the dispatcher loop (from identity slice 3, P 6.4) and the
 * scheduler. `main.ts` calls {@link start}; no lifecycle hook starts a loop, so building the
 * graph in a test starts no timer. {@link stop} runs on shutdown: no new pass, up to 10 s for
 * what is in flight. Safety never depends on a clean stop (P 6.2, 6.4).
 *
 * Each loop: a pass with a full batch is followed by the next at once; otherwise the loop
 * pauses 500 ms. A failed pass is logged and repeated after the pause.
 */
export class WorkerRuntime {
  private readonly logger = new Logger('WorkerRuntime');
  private running = false;
  private loops: Promise<void>[] = [];
  private heartbeat: NodeJS.Timeout | undefined;
  private readonly wakes = new Set<() => void>();

  constructor(
    private readonly relay: OutboxRelay,
    private readonly scheduler: Scheduler,
    private readonly dispatcher: EventDispatcher,
    private readonly idlePauseMs: number = RELAY_IDLE_PAUSE_MS,
  ) {}

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    const unhosted = await this.relay.unhostedMarketsWithRows();
    if (unhosted.length > 0) {
      // P 6.2, "Market": such rows are never claimed here.
      this.logger.error({ msg: 'outbox.unhosted-markets', marketIds: unhosted });
    }
    this.scheduler.start();
    this.loops = [
      this.loop(() => this.relay.runOnce(), 'outbox.relay-pass-failed'),
      this.loop(() => this.dispatcher.runOnce(), 'event-delivery.pass-failed'),
    ];
    this.heartbeat = setInterval(() => this.logger.log({ msg: 'worker.heartbeat' }), HEARTBEAT_MS);
    this.logger.log({ msg: 'worker.started' });
  }

  async stop(graceMs: number = STOP_GRACE_MS): Promise<void> {
    if (!this.running) return;
    this.running = false;
    clearInterval(this.heartbeat);
    for (const wake of [...this.wakes]) wake();
    let timeout: NodeJS.Timeout | undefined;
    const grace = new Promise<void>((resolve) => {
      timeout = setTimeout(resolve, graceMs);
    });
    await Promise.all([
      Promise.race([Promise.all(this.loops), grace]),
      this.scheduler.stop(graceMs),
    ]);
    clearTimeout(timeout);
    this.logger.log({ msg: 'worker.stopped' });
  }

  private async loop(pass: LoopPass, failure: string): Promise<void> {
    while (this.running) {
      let fullBatch = false;
      try {
        fullBatch = (await pass()).fullBatch;
      } catch (error) {
        this.logger.error({ msg: failure, err: error });
      }
      if (this.running && !fullBatch) await this.pause();
    }
  }

  private pause(): Promise<void> {
    return new Promise<void>((resolve) => {
      const wakes = this.wakes;
      const timer = setTimeout(done, this.idlePauseMs);
      function done(): void {
        clearTimeout(timer);
        wakes.delete(done);
        resolve();
      }
      wakes.add(done);
    });
  }
}
