import { Global, Module } from '@nestjs/common';
import { EventCatalogue } from './event-catalogue';
import { SubscriptionRegistry } from './event-subscriptions';

/**
 * Domain events (platform persistence design, "P", 5 and 6): the event catalogue every module
 * registers with and the subscription registry of the consume side (6.4; slice 3). The
 * permission-key lookup the outbox writer checks `permissionKey` fields against is the
 * permission registry, bound by `AuthzModule` (identity slice 8a-1). The writer,
 * the relay, the bus adapter and the dispatcher are bound by the persistence module, which
 * implements them (P 12.1).
 */
@Global()
@Module({
  providers: [EventCatalogue, SubscriptionRegistry],
  exports: [EventCatalogue, SubscriptionRegistry],
})
export class EventsModule {}
