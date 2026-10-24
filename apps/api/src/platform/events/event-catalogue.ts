import { Injectable, type OnApplicationBootstrap, type Provider } from '@nestjs/common';
import { describeEventDefinition } from '@mondapac-drive/shared-kernel';
import type { EventDefinition, EventDescription } from '@mondapac-drive/shared-kernel';

/** Registration refused at boot (P 5.3): a duplicate type, another module's type, or after sealing. */
export class EventCatalogueError extends Error {
  override readonly name = 'EventCatalogueError';
}

/**
 * Every event definition of the application (platform persistence design, "P", 5.3). Modules
 * register theirs at bootstrap with {@link registerEvents}; a duplicate type, or a type whose
 * first segment is not the registering module, fails boot. The catalogue is sealed when the
 * application has bootstrapped, the same in both roles (P 8), and read by the outbox writer.
 */
@Injectable()
export class EventCatalogue implements OnApplicationBootstrap {
  readonly #definitions = new Map<string, EventDefinition>();
  #sealed = false;

  register(module: string, definitions: readonly EventDefinition[]): void {
    if (this.#sealed) throw new EventCatalogueError('The event catalogue is sealed');
    for (const definition of definitions) {
      if (definition.module !== module) {
        throw new EventCatalogueError(
          `Module "${module}" cannot register "${definition.type}": a type starts with its module`,
        );
      }
      if (this.#definitions.has(definition.type)) {
        throw new EventCatalogueError(`The event type "${definition.type}" is registered twice`);
      }
      this.#definitions.set(definition.type, definition);
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

  /** The definition of `type`, or `undefined` when no module registered it. */
  get(type: string): EventDefinition | undefined {
    return this.#definitions.get(type);
  }

  /** Every type and its fields, sorted by type: what the contracts test compares (P 5.3). */
  snapshot(): EventDescription[] {
    return [...this.#definitions.values()]
      .map(describeEventDefinition)
      .sort((a, b) => (a.type < b.type ? -1 : a.type > b.type ? 1 : 0));
  }
}

/**
 * The one line of a module's Nest module that registers its events at bootstrap:
 * `providers: [registerEvents('identity', IDENTITY_EVENTS)]`.
 */
export function registerEvents(module: string, definitions: readonly EventDefinition[]): Provider {
  return {
    provide: Symbol(`events:${module}`),
    inject: [EventCatalogue],
    useFactory: (catalogue: EventCatalogue) => {
      catalogue.register(module, definitions);
      return module;
    },
  };
}

/**
 * Compares the catalogue with its checked-in snapshot (P 5.3). A new type fails until the
 * snapshot changes, so that each one is seen in review; a changed field list or aggregate type
 * of an existing type fails with "publish a new version" (ADR-0006 decision 6); a removed type
 * fails too. Returns one line per difference; empty when they agree.
 */
export function compareWithSnapshot(
  current: readonly EventDescription[],
  snapshot: readonly EventDescription[],
): string[] {
  const problems: string[] = [];
  const recorded = new Map(snapshot.map((entry) => [entry.type, entry]));
  const now = new Map(current.map((entry) => [entry.type, entry]));
  for (const entry of current) {
    const before = recorded.get(entry.type);
    if (before === undefined) {
      problems.push(`${entry.type} is new: add it to the snapshot, for security review`);
    } else if (JSON.stringify(canonical(before)) !== JSON.stringify(canonical(entry))) {
      problems.push(
        `${entry.type} changed its aggregate type or fields: publish a new version instead`,
      );
    }
  }
  for (const entry of snapshot) {
    if (!now.has(entry.type)) problems.push(`${entry.type} is in the snapshot but not registered`);
  }
  return problems;
}

/** Field order is not part of the contract; kinds and names are. */
function canonical(entry: EventDescription): unknown {
  return {
    type: entry.type,
    aggregateType: entry.aggregateType,
    fields: Object.entries(entry.fields).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  };
}
