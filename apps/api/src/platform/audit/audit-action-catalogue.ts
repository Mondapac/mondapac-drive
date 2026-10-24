import { Injectable, type OnApplicationBootstrap, type Provider } from '@nestjs/common';
import {
  canonicalJson,
  describeAuditAction,
  isAuditActionDefinition,
} from '@mondapac-drive/shared-kernel';
import type { AuditActionDefinition, AuditActionDescription } from '@mondapac-drive/shared-kernel';

/** Registration refused at boot (PA 3.2): a duplicate, a foreign action, or after sealing. */
export class AuditActionCatalogueError extends Error {
  override readonly name = 'AuditActionCatalogueError';
}

// A module name, or `platform.<component>` for a platform component (PA 3.2, Ali).
const OWNER = /^(?:platform\.)?[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/**
 * Every audited action of the application (docs/design/domain/platform-audit.md 3.2), like the
 * `EventCatalogue`. Modules register theirs at bootstrap with {@link registerAuditActions}; a
 * definition not made by `defineAuditAction`, an action whose prefix is not the registering
 * owner, or a duplicate fails boot. A platform component registers under
 * `platform.<component>`. The catalogue is sealed when the application has bootstrapped, the
 * same in both roles, and the audit writer refuses to write before that.
 */
@Injectable()
export class AuditActionCatalogue implements OnApplicationBootstrap {
  readonly #definitions = new Map<string, AuditActionDefinition>();
  #sealed = false;

  register(owner: string, definitions: readonly AuditActionDefinition[]): void {
    if (this.#sealed) throw new AuditActionCatalogueError('The audit action catalogue is sealed');
    if (typeof owner !== 'string' || owner === 'platform' || !OWNER.test(owner)) {
      throw new AuditActionCatalogueError(
        'An audit owner is a module name or "platform.<component>"',
      );
    }
    for (const definition of definitions) {
      if (!isAuditActionDefinition(definition)) {
        throw new AuditActionCatalogueError(
          `"${owner}" registered an audit action that defineAuditAction did not make`,
        );
      }
      if (definition.owner !== owner) {
        throw new AuditActionCatalogueError(
          `"${owner}" cannot register "${definition.action}": an action starts with its owner`,
        );
      }
      if (this.#definitions.has(definition.action)) {
        throw new AuditActionCatalogueError(
          `The audit action "${definition.action}" is registered twice`,
        );
      }
      this.#definitions.set(definition.action, definition);
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

  /** The definition of `action`, or `undefined` when no owner registered it. */
  get(action: string): AuditActionDefinition | undefined {
    return this.#definitions.get(action);
  }

  /** Every action and its shape, sorted by action: what the contracts test compares. */
  snapshot(): AuditActionDescription[] {
    return [...this.#definitions.values()]
      .map(describeAuditAction)
      .sort((a, b) => (a.action < b.action ? -1 : a.action > b.action ? 1 : 0));
  }
}

/**
 * The one line of a module's Nest module that registers its audit actions at bootstrap:
 * `providers: [registerAuditActions('identity', IDENTITY_AUDIT_ACTIONS)]`.
 */
export function registerAuditActions(
  owner: string,
  definitions: readonly AuditActionDefinition[],
): Provider {
  return {
    provide: Symbol(`audit-actions:${owner}`),
    inject: [AuditActionCatalogue],
    useFactory: (catalogue: AuditActionCatalogue) => {
      catalogue.register(owner, definitions);
      return owner;
    },
  };
}

/** Key order in the checked-in file is not part of the contract; content is. */
function sameShape(a: AuditActionDescription, b: AuditActionDescription): boolean {
  const left = canonicalJson(a);
  const right = canonicalJson(b);
  return left.ok && right.ok && left.value === right.value;
}

/**
 * Compares the catalogue with its checked-in snapshot (PA 3.2). Every new, changed or removed
 * action fails until the snapshot changes, so the security-tester reads each one in the diff.
 * Returns one line per difference; empty when they agree.
 */
export function compareAuditCatalogueWithSnapshot(
  current: readonly AuditActionDescription[],
  snapshot: readonly AuditActionDescription[],
): string[] {
  const problems: string[] = [];
  const recorded = new Map(snapshot.map((entry) => [entry.action, entry]));
  const now = new Set(current.map((entry) => entry.action));
  for (const entry of current) {
    const before = recorded.get(entry.action);
    if (before === undefined) {
      problems.push(`${entry.action} is new: add it to the snapshot, for security review`);
    } else if (!sameShape(before, entry)) {
      problems.push(`${entry.action} changed its shape: update the snapshot, for security review`);
    }
  }
  for (const entry of snapshot) {
    if (!now.has(entry.action))
      problems.push(`${entry.action} is in the snapshot but not registered`);
  }
  return problems;
}
