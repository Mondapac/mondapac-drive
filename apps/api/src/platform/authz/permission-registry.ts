import { Injectable, type OnApplicationBootstrap, type Provider } from '@nestjs/common';
import type { PermissionKeyLookup } from '../events/outbox-writer';
import { frozenKeySet } from './frozen-key-set';
import {
  definePermission,
  isDeclarablePermissionKey,
  isPermissionCatalogue,
  PERMISSION_SCOPES,
  type PermissionCatalogue,
  type PermissionDeclaration,
  type PermissionScope,
} from './permission';
import { RETIRED_PERMISSION_KEYS } from './retired-permission-keys';

/** A registration refused at boot, or a read before sealing: a programmer error. */
export class PermissionRegistryError extends Error {
  override readonly name = 'PermissionRegistryError';
}

const MODULE_NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/** The sealed catalogue, as a check registered with {@link PermissionRegistry.whenSealed} reads it. */
export interface SealedPermissionCatalogue {
  get(key: string): PermissionDeclaration | undefined;
  list(scope?: PermissionScope): readonly PermissionDeclaration[];
  keysOf(scope: PermissionScope): ReadonlySet<string>;
}

const byKey = (a: PermissionDeclaration, b: PermissionDeclaration) =>
  a.key < b.key ? -1 : a.key > b.key ? 1 : 0;

/**
 * The `PermissionRegistry` of platform-foundations design 6.1 (identity slice 8a-1): the code
 * catalogue of every module's permissions. Its guarantees:
 *
 * 1. Modules push their catalogues at bootstrap with {@link registerPermissions}; the registry
 *    imports no module. Boot fails on a duplicate key, a malformed key, a key whose first
 *    segment is not the registering module, or a value `declarePermissions` did not make.
 *    Every declaration is checked and copied again here, so a declaration object that changes
 *    after its catalogue was made changes nothing.
 * 2. It is sealed when the application has bootstrapped: `register` afterwards throws, and
 *    `get`, `list`, `keysOf` and `isKnownPermissionKey` throw before. The catalogue is the same
 *    in both roles, because both load the same modules.
 * 3. An unknown key grants nothing: `get` answers `undefined` and `keysOf` leaves it out.
 * 4. A retired key (the checked-in list) cannot be declared again; it is still known to
 *    {@link isKnownPermissionKey}, so an audit row or an event about it can be written, but it
 *    is never in a scope's keys.
 * 5. It holds the code catalogue only: no roles, no assignments, no Market data, no database.
 *
 * What it hands out is frozen (R-3 review N-2): declarations, lists, and the key set of each
 * scope, built once at sealing. It is also the {@link PermissionKeyLookup} of the outbox and
 * audit writers (bound in `AuthzModule`), which replaced the fail-closed `NO_PERMISSION_KEYS`.
 */
@Injectable()
export class PermissionRegistry
  implements PermissionKeyLookup, SealedPermissionCatalogue, OnApplicationBootstrap
{
  readonly #declarations = new Map<string, PermissionDeclaration>();
  readonly #retired: ReadonlySet<string>;
  readonly #checks: ((catalogue: SealedPermissionCatalogue) => void)[] = [];
  #sealed = false;
  #all: readonly PermissionDeclaration[] = Object.freeze([]);
  #byScope = new Map<PermissionScope, readonly PermissionDeclaration[]>();
  #keysByScope = new Map<PermissionScope, ReadonlySet<string>>();

  constructor(retired: readonly string[] = RETIRED_PERMISSION_KEYS) {
    for (const key of retired) {
      if (!isDeclarablePermissionKey(key)) {
        throw new PermissionRegistryError(`The retired list holds a malformed or overlong key`);
      }
    }
    this.#retired = frozenKeySet(retired);
  }

  register(module: string, catalogue: PermissionCatalogue): void {
    if (this.#sealed) throw new PermissionRegistryError('The permission registry is sealed');
    if (typeof module !== 'string' || !MODULE_NAME.test(module)) {
      throw new PermissionRegistryError('A permission is registered by a module name');
    }
    if (!isPermissionCatalogue(catalogue)) {
      throw new PermissionRegistryError(
        `"${module}" registered a catalogue that declarePermissions did not make`,
      );
    }
    if (catalogue.module !== module) {
      throw new PermissionRegistryError(
        `"${module}" cannot register the catalogue of "${catalogue.module}"`,
      );
    }
    const checked: PermissionDeclaration[] = [];
    for (const declaration of catalogue.declarations) {
      let copy: PermissionDeclaration;
      try {
        copy = definePermission(module, {
          key: declaration.key,
          scope: declaration.scope,
          protected: declaration.protected,
        });
      } catch (error) {
        throw new PermissionRegistryError(
          `"${module}" registered a malformed declaration: ${(error as Error).message}`,
        );
      }
      if (this.#retired.has(copy.key)) {
        throw new PermissionRegistryError(
          `The permission "${copy.key}" is retired and cannot be declared again (R10)`,
        );
      }
      if (this.#declarations.has(copy.key) || checked.some((d) => d.key === copy.key)) {
        throw new PermissionRegistryError(`The permission "${copy.key}" is registered twice`);
      }
      checked.push(copy);
    }
    for (const declaration of checked) this.#declarations.set(declaration.key, declaration);
  }

  /**
   * Runs `check` once the catalogue is sealed, at boot; a check that throws fails boot. A module
   * uses it for what must agree with the catalogue (identity's role seed, identity design 5.6).
   */
  whenSealed(check: (catalogue: SealedPermissionCatalogue) => void): void {
    if (this.#sealed) throw new PermissionRegistryError('The permission registry is sealed');
    this.#checks.push(check);
  }

  seal(): void {
    if (this.#sealed) return;
    const all = [...this.#declarations.values()].sort(byKey);
    this.#all = Object.freeze(all);
    for (const scope of PERMISSION_SCOPES) {
      const ofScope = Object.freeze(all.filter((d) => d.scope === scope));
      this.#byScope.set(scope, ofScope);
      this.#keysByScope.set(scope, frozenKeySet(ofScope.map((d) => d.key)));
    }
    this.#sealed = true;
    for (const check of this.#checks.splice(0)) check(this);
  }

  get sealed(): boolean {
    return this.#sealed;
  }

  onApplicationBootstrap(): void {
    this.seal();
  }

  get(key: string): PermissionDeclaration | undefined {
    this.assertSealed();
    return this.#declarations.get(key);
  }

  /** Every declaration, or those of one scope, sorted by key; frozen. */
  list(scope?: PermissionScope): readonly PermissionDeclaration[] {
    this.assertSealed();
    return scope === undefined ? this.#all : (this.#byScope.get(scope) ?? Object.freeze([]));
  }

  /** The keys declared in a scope: a frozen set, the same object on every call (N-2). */
  keysOf(scope: PermissionScope): ReadonlySet<string> {
    this.assertSealed();
    const keys = this.#keysByScope.get(scope);
    if (keys === undefined) throw new PermissionRegistryError(`Unknown scope "${String(scope)}"`);
    return keys;
  }

  /**
   * For `permissionKey` fields of events and audit rows (P 5.3, PA W4): a declared key or a
   * retired one. Never an answer to "may this actor": that is `keysOf` through `effectiveKeysOf`.
   */
  isKnownPermissionKey(key: string): boolean {
    this.assertSealed();
    return this.#declarations.has(key) || this.#retired.has(key);
  }

  private assertSealed(): void {
    if (!this.#sealed) {
      throw new PermissionRegistryError('The permission registry is not sealed yet');
    }
  }
}

/**
 * The one line of a module's Nest module that pushes its catalogue at bootstrap (guarantee 1):
 * `providers: [registerPermissions('identity', IDENTITY_PERMISSIONS)]`. The name is the module's
 * folder; a contracts test checks it, and that every catalogue in a `contracts/` folder is
 * registered.
 */
export function registerPermissions(module: string, catalogue: PermissionCatalogue): Provider {
  return {
    provide: Symbol(`permissions:${module}`),
    inject: [PermissionRegistry],
    useFactory: (registry: PermissionRegistry) => {
      registry.register(module, catalogue);
      return module;
    },
  };
}
