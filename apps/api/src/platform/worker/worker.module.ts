import { Module } from '@nestjs/common';
import { OUTBOX_RELAY, type OutboxRelay } from '../events/event-bus';
import { EVENT_DISPATCHER, type EventDispatcher } from '../events/event-delivery';
import { Scheduler } from '../scheduler/scheduler';
import { WorkerRuntime } from './worker-runtime';

/**
 * The worker runtime (platform persistence design, "P", 8). Part of the one module graph both
 * roles build; only the `worker` role's start function calls `WorkerRuntime.start()`.
 */
@Module({
  providers: [
    {
      provide: WorkerRuntime,
      inject: [OUTBOX_RELAY, Scheduler, EVENT_DISPATCHER],
      useFactory: (relay: OutboxRelay, scheduler: Scheduler, dispatcher: EventDispatcher) =>
        new WorkerRuntime(relay, scheduler, dispatcher),
    },
  ],
  exports: [WorkerRuntime],
})
export class WorkerModule {}
