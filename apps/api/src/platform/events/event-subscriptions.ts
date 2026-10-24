import {
  Injectable,
  type InjectionToken,
  type OnApplicationBootstrap,
  type Provider,
} from '@nestjs/common';
import type {
  CallContext,
  DomainEvent,
  EventDefinition,
  PayloadFields,
  PayloadOf,
  SystemActor,
} from '@mondapac-drive/shared-kernel';
import type { EventDelivery } from './event-delivery';

/**
 * What a handler receives as its context (platform persistence design, "P", 6.4; foundations
 * 5.1): a minted `CallContext` of the envelope's Market, that Market's system actor and the
 * envelope's correlation id, built by the dispatcher. The handler passes it unchanged to one use
 * case whose access rule is `system`.
 */
export type SubscriberContext = CallContext & { readonly actor: SystemActor };

/** A consumed event: the envelope, with the payload decoded against the subscriber's definition. */
export type ConsumedEvent<F extends PayloadFields> = Omit<DomainEvent, 'payload'> & {
  readonly payload: PayloadOf<F>;
};

/** The envelope as the dispatcher holds it, before the subscription's own type applies. */
export type ConsumedEnvelope = Omit<DomainEvent, 'payload'> & { readonly payload: unknown };

/**
 * One subscription (P 6.4), declared in the consuming module's `presentation/subscribers/`. The
 * definition is imported from the publisher's `contracts/` (or, for a module's own events, its
 * `domain/events/`). `handle` calls one `system` use case with the delivery and the context
 * unchanged; that use case opens its unit with `UnitOfWork.runOnce`. Delivery is at least once
 * and in no order: the use case compares `aggregateVersion` with what it stored.
 */
export interface EventSubscription<F extends PayloadFields> {
  /** `<module>.<handler>`: the delivery's `subscriber` and the inbox's `handler`. */
  readonly name: string;
  readonly event: EventDefinition<string, F>;
  handle(
    event: ConsumedEvent<F>,
    delivery: EventDelivery,
    context: SubscriberContext,
  ): Promise<void>;
}

/**
 * A subscription with its payload type erased, as the registry stores it (`PayloadOf` of the
 * open field set is too deep for tsc). Build one with {@link subscription}.
 */
export interface RegisteredSubscription {
  readonly name: string;
  readonly event: { readonly type: string; readonly fields: PayloadFields };
  handle(
    event: ConsumedEnvelope,
    delivery: EventDelivery,
    context: SubscriberContext,
  ): Promise<void>;
}

/**
 * Declares a subscription, typed by its definition, and erases the payload type for the
 * registry. The dispatcher decodes the payload against `event.fields` before `handle` runs.
 */
export function subscription<F extends PayloadFields>(
  declared: EventSubscription<F>,
): RegisteredSubscription {
  return {
    name: declared.name,
    event: { type: declared.event.type, fields: declared.event.fields },
    handle: (event, delivery, context) =>
      declared.handle(event as unknown as ConsumedEvent<F>, delivery, context),
  };
}

/** Registration refused at boot (P 6.4). */
export class SubscriptionRegistryError extends Error {
  override readonly name = 'SubscriptionRegistryError';
}

const SUBSCRIBER_NAME = /^([a-z][a-z0-9-]*)\.[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Every subscription of the application (P 6.4). Modules register at bootstrap: the first
 * segment of a name is the registering module, a name is registered once, and the registry is
 * sealed when the application has bootstrapped, the same in both roles (P 8). The in-process
 * bus fans each published event out to the subscriptions of its type; the dispatcher finds a
 * delivery's subscription by name.
 */
@Injectable()
export class SubscriptionRegistry implements OnApplicationBootstrap {
  readonly #byName = new Map<string, RegisteredSubscription>();
  #sealed = false;

  register(module: string, subscriptions: readonly RegisteredSubscription[]): void {
    if (this.#sealed) throw new SubscriptionRegistryError('The subscription registry is sealed');
    for (const entry of subscriptions) {
      const name = SUBSCRIBER_NAME.exec(entry.name);
      if (name === null || name[1] !== module) {
        throw new SubscriptionRegistryError(
          `Module "${module}" cannot register the subscription "${entry.name}"`,
        );
      }
      if (this.#byName.has(entry.name)) {
        throw new SubscriptionRegistryError(`The subscription "${entry.name}" is registered twice`);
      }
      this.#byName.set(entry.name, entry);
    }
  }

  seal(): void {
    this.#sealed = true;
  }

  get sealed(): boolean {
    return this.#sealed;
  }

  onApplicationBootstrap(): void {
    this.seal();
  }

  /** The subscription of this name, or undefined. */
  get(name: string): RegisteredSubscription | undefined {
    return this.#byName.get(name);
  }

  /** The names of the subscriptions to `type`, sorted. */
  subscribersOf(type: string): string[] {
    return [...this.#byName.values()]
      .filter((entry) => entry.event.type === type)
      .map((entry) => entry.name)
      .sort();
  }

  /** Every subscription name, sorted. */
  names(): string[] {
    return [...this.#byName.keys()].sort();
  }
}

/**
 * The one line of a module's Nest module that registers its subscriptions; `build` receives
 * the providers named in `inject` (its use cases), in order:
 * `registerSubscriptionsFrom('identity', [SendMail], (send) => [subscription({...})])`.
 */
export function registerSubscriptionsFrom(
  module: string,
  inject: readonly InjectionToken[],
  build: (...dependencies: never[]) => readonly RegisteredSubscription[],
): Provider {
  return {
    provide: Symbol(`subscriptions:${module}`),
    inject: [SubscriptionRegistry, ...inject],
    useFactory: (registry: SubscriptionRegistry, ...dependencies: never[]) => {
      registry.register(module, build(...dependencies));
      return module;
    },
  };
}
