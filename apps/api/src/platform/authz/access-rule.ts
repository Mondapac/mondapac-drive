import { err, ok } from '@mondapac-drive/shared-kernel';
import type { Result } from '@mondapac-drive/shared-kernel';

/**
 * A permission key, `<module>.<resource>.<action>` (platform-foundations design 6.1): three
 * lower-case segments, the first the declaring module. The brand is given by
 * `definePermission` only, so a rule names the constants of a module's `contracts/`, never a
 * literal.
 */
export type PermissionKey = string & { readonly __brand: 'PermissionKey' };

/** The single definition of the key pattern (foundations 6.1). */
export const PERMISSION_KEY_PATTERN = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*){2}$/;

/**
 * The closed set of access-rule kinds (foundations 6.2; ADR-0018 decision 4), one rule per use
 * case, `allOf` only. Adding a kind, or an "any of", amends ADR-0018 decision 4.
 *
 * - `anonymous`: no authentication required. It admits the anonymous actor and an
 *   authenticated one, never the system actor, and the use case always receives the Market's
 *   anonymous actor (identity design 5.1, HF9).
 * - `own-resources`: an authenticated actor, on what its own account owns.
 * - `system`: the system actor only; never satisfiable from HTTP.
 * - `permissions`: an authenticated actor that holds every listed key.
 */
export type AccessRule =
  | { readonly kind: 'permissions'; readonly allOf: readonly [PermissionKey, ...PermissionKey[]] }
  | { readonly kind: 'anonymous' }
  | { readonly kind: 'own-resources' }
  | { readonly kind: 'system' };

export const ACCESS_RULE_KINDS = ['permissions', 'anonymous', 'own-resources', 'system'] as const;
export type AccessRuleKind = AccessRule['kind'];

/**
 * The static declaration of a use case (identity design 5.2): readable without running
 * anything, held as an own property `access` of the concrete class (HF4).
 * The marketplace's `whenSellerNotApproved` attribute is not part of Drive: a merchant is active
 * or suspended, and a suspended merchant is simply denied.
 */
export interface AccessDeclaration {
  /** `<module>.<use-case>`, unique; used in denial logs. */
  readonly name: string;
  readonly rule: AccessRule;
}

/** `<module>.<use-case>`: the module's folder name, then the use case's file stem. */
export const USE_CASE_NAME_PATTERN = /^[a-z][a-z0-9-]*\.[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/** Why a declaration is refused. Codes only: a declaration never reaches a response. */
export type DeclarationProblem =
  | 'declaration-missing'
  | 'declaration-not-an-object'
  | 'declaration-unknown-field'
  | 'name-invalid'
  | 'rule-not-an-object'
  | 'rule-kind-unknown'
  | 'rule-unknown-field'
  | 'keys-missing'
  | 'key-invalid'
  | 'key-duplicate';

const DECLARATION_FIELDS = new Set(['name', 'rule']);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function checkRule(rule: unknown): DeclarationProblem | null {
  if (!isRecord(rule)) return 'rule-not-an-object';
  if (!(ACCESS_RULE_KINDS as readonly unknown[]).includes(rule.kind)) return 'rule-kind-unknown';
  const fields = Object.keys(rule).filter((field) => field !== 'kind');
  if (rule.kind !== 'permissions') return fields.length === 0 ? null : 'rule-unknown-field';
  if (fields.some((field) => field !== 'allOf')) return 'rule-unknown-field';
  const keys = rule.allOf;
  if (!Array.isArray(keys) || keys.length === 0) return 'keys-missing';
  if (keys.some((key) => typeof key !== 'string' || !PERMISSION_KEY_PATTERN.test(key))) {
    return 'key-invalid';
  }
  return new Set(keys).size === keys.length ? null : 'key-duplicate';
}

/**
 * Validates a declaration's shape (identity design 5.2). The gate runs it on every call and
 * the base class at construction; the CI check adds what needs the whole code base (unique
 * names, declared keys and their scopes, the checked-in list).
 */
export function checkAccessDeclaration(
  value: unknown,
): Result<AccessDeclaration, { readonly code: DeclarationProblem }> {
  if (value === undefined) return err({ code: 'declaration-missing' });
  if (!isRecord(value)) return err({ code: 'declaration-not-an-object' });
  if (Object.keys(value).some((field) => !DECLARATION_FIELDS.has(field))) {
    return err({ code: 'declaration-unknown-field' });
  }
  if (typeof value.name !== 'string' || !USE_CASE_NAME_PATTERN.test(value.name)) {
    return err({ code: 'name-invalid' });
  }
  const ruleProblem = checkRule(value.rule);
  if (ruleProblem !== null) return err({ code: ruleProblem });
  return ok(value as unknown as AccessDeclaration);
}

/**
 * The declaration of a use-case class, read only as an own property of the class: a subclass
 * never inherits its parent's rule (HF4).
 */
export function accessDeclarationOf(
  useCase: unknown,
): Result<AccessDeclaration, { readonly code: DeclarationProblem }> {
  if (typeof useCase !== 'function' || !Object.hasOwn(useCase, 'access')) {
    return err({ code: 'declaration-missing' });
  }
  return checkAccessDeclaration((useCase as { access?: unknown }).access);
}
