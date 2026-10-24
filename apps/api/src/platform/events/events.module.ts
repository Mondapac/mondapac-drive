import { Global, Module } from '@nestjs/common';
import { EventCatalogue } from './event-catalogue';
import { SubscriptionRegistry } from './event-subscriptions';
import { NO_PERMISSION_KEYS, PERMISSION_KEY_LOOKUP } from './outbox-writer';

/**
 * Domain events (platform persistence design, "P", 5 and 6): the event catalogue every module
 * registers with and the subscription registry of the consume side (6.4; slice 3). The
 * permission-key lookup the outbox and audit writers check `permissionKey` fields against knows
 * no key until the permission registry arrives with identity, whose `AuthzModule` binds it
 * instead. The writer, the relay, the bus adapter and the dispatcher are bound by the
 * persistence module, which implements them (P 12.1).
 */
@Global()
@Module({
  providers: [
    EventCatalogue,
    SubscriptionRegistry,
    { provide: PERMISSION_KEY_LOOKUP, useValue: NO_PERMISSION_KEYS },
  ],
  exports: [EventCatalogue, SubscriptionRegistry, PERMISSION_KEY_LOOKUP],
})
export class EventsModule {}
