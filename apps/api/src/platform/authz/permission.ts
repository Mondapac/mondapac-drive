import { PERMISSION_KEY_PATTERN, type PermissionKey } from './access-rule';

/**
 * The longest permission key a module may declare (slice 8a-1; Ali's ruling on Mohammad's
 * review): the stored column's limit, the CHECK on `identity.role_permissions.permission_key`
 * (`char_length <= 128`, migration 20261008063654). A longer key could never be stored in a role,
 * so `definePermission` refuses it at boot. Audit rows that list keys are bounded separately, by
 * the byte budget of a seeded role's keys (`identity/application/roles/role-seed-budget.ts`).
 */
export const MAX_PERMISSION_KEY_LENGTH = 128;

/** True for a well-formed key no longer than {@link MAX_PERMISSION_KEY_LENGTH}. */
export function isDeclarablePermissionKey(key: unknown): key is string {
  return (
    typeof key === 'string' &&
    key.length <= MAX_PERMISSION_KEY_LENGTH &&
    PERMISSION_KEY_PATTERN.test(key)
  );
}

/**
 * The scopes of a permission, one per population: `platform` for admins, `merchant` and
 * `courier` for those populations.
 */
export const PERMISSION_SCOPES = ['platform', 'merchant', 'courier'] as const;
export type PermissionScope = (typeof PERMISSION_SCOPES)[number];

/**
 * One permission (platform-foundations design 6.1). Declared as a constant in the owning
 * module's `contracts/` through {@link definePermission}; use cases name the constant's `key`.
 * No Market, no vertical and no display text: labels are translation keys derived from the key.
 */
export interface PermissionDeclaration {
  readonly key: PermissionKey;
  readonly scope: PermissionScope;
  /** R11; always written out, there is no default. */
  readonly protected: boolean;
}

/** Every permission one module declares, as the CI check and (slice 8a) the registry read it. */
export interface PermissionCatalogue {
  readonly module: string;
  readonly declarations: readonly PermissionDeclaration[];
}

/** A malformed declaration: a programmer error, refused when the module is loaded. */
export class PermissionDeclarationError extends Error {
  override readonly name = 'PermissionDeclarationError';
}

const catalogues = new WeakSet<object>();

/**
 * The one helper that validates and brands a key (foundations 6.1): three lower-case segments,
 * the first the declaring module; a scope of the closed list; `protected` written out.
 */
export function definePermission(
  module: string,
  declaration: {
    readonly key: string;
    readonly scope: PermissionScope;
    readonly protected: boolean;
  },
): PermissionDeclaration {
  const { key, scope } = declaration;
  if (!isDeclarablePermissionKey(key)) {
    throw new PermissionDeclarationError(
      `Malformed or overlong permission key "${String(key)}" (at most ${MAX_PERMISSION_KEY_LENGTH} characters)`,
    );
  }
  if (key.split('.')[0] !== module) {
    throw new PermissionDeclarationError(`Module "${module}" cannot declare "${key}"`);
  }
  if (!(PERMISSION_SCOPES as readonly unknown[]).includes(scope)) {
    throw new PermissionDeclarationError(`Permission "${key}" has no valid scope`);
  }
  if (typeof declaration.protected !== 'boolean') {
    throw new PermissionDeclarationError(`Permission "${key}" must state protected`);
  }
  return Object.freeze({ key: key as PermissionKey, scope, protected: declaration.protected });
}

/**
 * A module's catalogue, exported from its `contracts/` (foundations 6.1). Refuses a duplicate
 * key and a declaration of another module. The value is recognised by
 * {@link isPermissionCatalogue}, which is how the CI check finds every declared key.
 */
export function declarePermissions(
  module: string,
  declarations: readonly PermissionDeclaration[],
): PermissionCatalogue {
  const keys = new Set<string>();
  for (const declaration of declarations) {
    const checked = definePermission(module, declaration);
    if (keys.has(checked.key)) {
      throw new PermissionDeclarationError(`Permission "${checked.key}" is declared twice`);
    }
    keys.add(checked.key);
  }
  const catalogue = Object.freeze({ module, declarations: Object.freeze([...declarations]) });
  catalogues.add(catalogue);
  return catalogue;
}

/** True only for a value {@link declarePermissions} returned. */
export function isPermissionCatalogue(value: unknown): value is PermissionCatalogue {
  return typeof value === 'object' && value !== null && catalogues.has(value);
}
