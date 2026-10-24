// Audit actions (docs/design/domain/platform-audit.md 3; ADR-0004 decision 7, ADR-0009 V4).
// A module declares each audited action with `defineAuditAction` in its `domain/` and
// re-exports it from `contracts/`; its use case builds an entry with `definition.entry(...)`
// and hands it to its own bound AuditWriter (platform/audit), which stamps the id, the Market,
// the actor, the correlation id and the time, and checks the entry against the sealed
// catalogue again.
//
// `before` and `after` fields come from the closed payload vocabulary of P 5.3, as events do:
// no kind accepts free text, so a reason, a name or an email cannot be declared (ADR-0009
// decision 6, R5; PA 3.2). `listOf` takes a required maximum length (Hassan L3). `money` is the
// one kind of audit rows only (pricing condition (h)): a `Money` written as a digit string of
// minor units and its currency, never a float. A new kind is a kernel change reviewed by the
// security-tester.
import { copyListOnce, eventField, instantText, MAX_ENUM_VALUES } from './domain-event';
import type {
  BooleanKind,
  EnumKind,
  IdKind,
  InstantKind,
  IntegerKind,
  JsonObject,
  JsonValue,
  PermissionKeyKind,
} from './domain-event';
import { parseId } from './id';
import type { Id } from './id';
import { MAX_WIRE_AMOUNT_DIGITS, parseMinorUnits, parseMoney } from './money';
import type { Money } from './money';
import { err, ok } from './result';
import type { Result } from './result';
import type { Temporal } from './time';

// ---------------------------------------------------------------------------------------------
// Field kinds

/** The longest `listOf` maximum a definition may declare. */
export const MAX_AUDIT_LIST_LENGTH = 256;

export interface AuditListKind<K extends AuditPlainKind = AuditPlainKind> {
  readonly kind: 'listOf';
  readonly of: K;
  /** The longest list the writer accepts (Hassan L3). */
  readonly max: number;
}
export interface AuditOptionalKind<K extends AuditPlainKind = AuditPlainKind> {
  readonly kind: 'optional';
  readonly of: K;
}

/**
 * An amount of money: a `Money` whose amount is above zero and has at most 16 digits
 * (`MAX_WIRE_AMOUNT_DIGITS`), in a known ISO 4217 currency. Its jsonb form is
 * `{"amount": "<minor units as digits>", "currency": "<code>"}` (PA 3.2).
 */
export interface AuditMoneyKind {
  readonly kind: 'money';
}

/** The kinds `listOf` and `optional` may wrap. */
export type AuditPlainKind =
  IdKind | EnumKind | BooleanKind | IntegerKind | InstantKind | PermissionKeyKind | AuditMoneyKind;

/** The closed vocabulary of `before` and `after` fields (PA 3.2). */
export type AuditFieldKind = AuditPlainKind | AuditListKind | AuditOptionalKind;

/** The declared fields of one side (`before` or `after`): field name to kind. */
export type AuditFields = Readonly<Record<string, AuditFieldKind>>;

function listOf<K extends AuditPlainKind>(of: K, max: number): AuditListKind<K> {
  return Object.freeze({ kind: 'listOf', of, max });
}

/**
 * The constructors of the vocabulary. `enumOf` takes literal constants:
 * `auditField.enumOf(['active', 'suspended'] as const)`. `listOf` takes its maximum length:
 * `auditField.listOf(auditField.permissionKey(), 64)`.
 */
export const auditField = Object.freeze({
  id: eventField.id,
  enumOf: eventField.enumOf,
  boolean: eventField.boolean,
  integer: eventField.integer,
  instant: eventField.instant,
  permissionKey: eventField.permissionKey,
  money: (): AuditMoneyKind => Object.freeze({ kind: 'money' }),
  listOf,
  optional: <K extends AuditPlainKind>(of: K): AuditOptionalKind<K> =>
    Object.freeze({ kind: 'optional', of }),
});

/** The in-memory value of a field of kind `K`, as a use case passes it to `entry`. */
export type AuditFieldValue<K extends AuditFieldKind> = K extends IdKind
  ? Id
  : K extends EnumKind<infer V>
    ? V
    : K extends BooleanKind
      ? boolean
      : K extends IntegerKind
        ? number
        : K extends InstantKind
          ? Temporal.Instant
          : K extends PermissionKeyKind
            ? string
            : K extends AuditMoneyKind
              ? Money
              : K extends AuditListKind<infer Of>
                ? readonly AuditFieldValue<Of>[]
                : K extends AuditOptionalKind<infer Of>
                  ? AuditFieldValue<Of> | null
                  : never;

/** The values of one side with fields `F`: every declared field, nothing else. */
export type AuditValuesOf<F extends AuditFields> = {
  readonly [Name in keyof F]: AuditFieldValue<F[Name]>;
};

// ---------------------------------------------------------------------------------------------
// Definitions

/** The actor kinds of `ActorContext` an action may be recorded under (PA 3.2, W2). */
export const AUDIT_ACTOR_KINDS = ['authenticated', 'system', 'anonymous'] as const;
export type AuditActorKind = (typeof AUDIT_ACTOR_KINDS)[number];

/** The `after` field that names the bound account or invitation of an anonymous row (W4a). */
export const BOUND_SUBJECT_FIELD = 'boundSubjectId';

// A segment of an action or target type: lower-case letters and digits joined by hyphens, as
// the `audit_log_action_check` and `audit_log_target_type_check` CHECKs allow.
const SEGMENT = '[a-z][a-z0-9]*(?:-[a-z0-9]+)*';
// `<module>.<subject>.<verb>` for a module; `platform.<component>.<verb>` or
// `platform.<component>.<subject>.<verb>` for a platform component, whose owner is
// `platform.<component>` (PA 3.2: "that prefix counts as its own first segment").
const MODULE_ACTION = new RegExp(`^(${SEGMENT})\\.${SEGMENT}\\.${SEGMENT}$`);
const PLATFORM_ACTION = new RegExp(`^(platform\\.${SEGMENT})(?:\\.${SEGMENT}){1,2}$`);
const TYPE_TAIL = new RegExp(`^${SEGMENT}$`);
const FIELD_NAME = /^[a-z][A-Za-z0-9]*$/;
/** The `char_length` limit of the action and target type CHECKs. */
const MAX_CODE_LENGTH = 128;

/**
 * What a use case hands to its AuditWriter: built only by a definition's `entry`. No id, Market,
 * actor, correlation id or time: the writer stamps those (PA W2, W3).
 */
export interface AuditEntry<A extends string = string> {
  readonly action: A;
  readonly targetType: string;
  readonly targetId: string;
  readonly before: unknown;
  readonly after: unknown;
}

type Side<Name extends 'before' | 'after', S> = S extends AuditFields
  ? { readonly [N in Name]: AuditValuesOf<S> }
  : { readonly [N in Name]?: null };

/** The values `entry` takes: each declared side in full; an undeclared side absent. */
export type AuditEntryValues<B, F> = Side<'before', B> & Side<'after', F>;

/** The value of a target id of kind `T`: an `Id`, or a value of the declared `enumOf`. */
export type AuditTargetValue<T extends IdKind | EnumKind> = T extends EnumKind<infer V> ? V : Id;

export interface AuditActionDefinition<
  A extends string = string,
  B extends AuditFields | undefined = AuditFields | undefined,
  F extends AuditFields | undefined = AuditFields | undefined,
  T extends IdKind | EnumKind = IdKind | EnumKind,
> {
  /** `<module>.<subject>.<verb>`, or `platform.<component>[.<subject>].<verb>`. */
  readonly action: A;
  /** The module, or `platform.<component>`, that may write it: the action's prefix. */
  readonly owner: string;
  /** `<owner>.<type>`: the aggregate that changed (PA 4). */
  readonly targetType: string;
  /** `id`, or an `enumOf` of natural keys (PA 3.2). */
  readonly targetId: T;
  /** Sorted, distinct, never empty. */
  readonly actors: readonly AuditActorKind[];
  readonly before: B extends AuditFields ? B : null;
  readonly after: F extends AuditFields ? F : null;
  /** The entry of this action for one target. The writer checks it again, in full. */
  entry(targetId: AuditTargetValue<T>, values: AuditEntryValues<B, F>): AuditEntry<A>;
}

// Definitions made by defineAuditAction, so that the catalogue refuses an object literal that
// skipped the checks below.
const DEFINED = new WeakSet<object>();

/** True for a definition returned by {@link defineAuditAction}, and nothing else. */
export function isAuditActionDefinition(value: unknown): value is AuditActionDefinition {
  return typeof value === 'object' && value !== null && DEFINED.has(value);
}

function fail(message: string): never {
  throw new TypeError(`defineAuditAction: ${message}`);
}

/**
 * The kind rebuilt through its {@link auditField} constructor (Hassan L3 on slice 6a): the
 * definition stores only frozen objects made here, never the caller's, so a kind written as
 * an object literal, a getter or a Proxy cannot change after the checks. Each property of the
 * caller's object is read once.
 */
function tagOf(kind: unknown): unknown {
  return (kind as { readonly kind?: unknown } | null)?.kind;
}

function rebuildPlainKind(kind: unknown, tag: unknown = tagOf(kind)): AuditPlainKind {
  switch (tag) {
    case 'id':
      return auditField.id();
    case 'boolean':
      return auditField.boolean();
    case 'integer':
      return auditField.integer();
    case 'instant':
      return auditField.instant();
    case 'permissionKey':
      return auditField.permissionKey();
    case 'money':
      return auditField.money();
    case 'enumOf': {
      const values = (kind as { readonly values?: unknown }).values;
      if (!Array.isArray(values)) return fail('enumOf needs a list of values');
      // One copy, by index and with the length read once (Hassan R2 on slice 6a); enumOf then
      // checks, de-duplicates and freezes that copy, never the caller's array.
      const copied = copyListOnce(values, MAX_ENUM_VALUES);
      if (copied === undefined || !('copy' in copied)) {
        return fail(`enumOf needs a list of 1 to ${MAX_ENUM_VALUES} values`);
      }
      return auditField.enumOf(copied.copy as [string, ...string[]]);
    }
    case 'listOf':
    case 'optional':
      return fail('optional and listOf apply to a plain kind only');
    default:
      return fail('a field kind must come from auditField');
  }
}

function rebuildKind(kind: unknown): AuditFieldKind {
  const tag = tagOf(kind);
  if (tag === 'listOf') {
    const { max, of } = kind as { readonly max?: unknown; readonly of?: unknown };
    if (
      typeof max !== 'number' ||
      !Number.isInteger(max) ||
      max < 1 ||
      max > MAX_AUDIT_LIST_LENGTH
    ) {
      fail(`listOf needs a maximum length from 1 to ${MAX_AUDIT_LIST_LENGTH}`);
    }
    return auditField.listOf(rebuildPlainKind(of), max);
  }
  if (tag === 'optional') {
    return auditField.optional(rebuildPlainKind((kind as { readonly of?: unknown }).of));
  }
  return rebuildPlainKind(kind, tag);
}

function checkFields(side: 'before' | 'after', fields: unknown): AuditFields | null {
  if (fields === undefined || fields === null) return null;
  if (typeof fields !== 'object' || Array.isArray(fields)) fail(`${side} must be a field map`);
  const entries = Object.entries(fields as Record<string, unknown>);
  if (entries.length === 0) fail(`${side} declares no field: leave it out instead`);
  const checked: Record<string, AuditFieldKind> = {};
  for (const [name, kind] of entries) {
    if (!FIELD_NAME.test(name)) fail('a field name must be camelCase letters and digits');
    checked[name] = rebuildKind(kind);
  }
  return Object.freeze(checked);
}

/**
 * Declares one audited action (PA 3.2). Throws `TypeError` when the module loads, so boot
 * fails, on: a malformed action or one whose target type is not `<owner>.<type>`; an empty,
 * repeated or unknown actor kind; a field kind outside {@link auditField}; a `listOf` without
 * a maximum; an empty side; and an action open to `anonymous` whose `after` does not declare
 * `boundSubjectId` of kind `id` (W4a). The target id is an `id` unless an `enumOf` is given.
 */
export function defineAuditAction<
  const A extends string,
  const B extends AuditFields | undefined = undefined,
  const F extends AuditFields | undefined = undefined,
  const T extends IdKind | EnumKind = IdKind,
>(declaration: {
  readonly action: A;
  readonly targetType: string;
  readonly targetId?: T;
  readonly actors: readonly AuditActorKind[];
  readonly before?: B;
  readonly after?: F;
}): AuditActionDefinition<A, B, F, T> {
  const { action, targetType, actors } = declaration;
  if (typeof action !== 'string' || action.length > MAX_CODE_LENGTH) {
    fail('the action must be a code of at most 128 characters');
  }
  const parts = PLATFORM_ACTION.exec(action) ?? MODULE_ACTION.exec(action);
  if (parts === null) {
    fail('the action must read "<module>.<subject>.<verb>" or "platform.<component>.<verb>"');
  }
  const owner = parts[1]!;
  if (
    typeof targetType !== 'string' ||
    targetType.length > MAX_CODE_LENGTH ||
    !targetType.startsWith(`${owner}.`) ||
    !TYPE_TAIL.test(targetType.slice(owner.length + 1))
  ) {
    fail(`the target type must read "${owner}.<type>"`);
  }
  const declaredTargetId: unknown = declaration.targetId ?? auditField.id();
  const targetTag = tagOf(declaredTargetId);
  if (targetTag !== 'id' && targetTag !== 'enumOf') {
    fail('the target id is an id or an enumOf of natural keys');
  }
  const targetId = rebuildPlainKind(declaredTargetId, targetTag) as T;

  // `Array.isArray` narrows a readonly array to `any[]`; check a copy of the declared type.
  const actorList: readonly AuditActorKind[] = Array.isArray(actors) ? actors : [];
  if (actorList.length === 0) fail('actors must list at least one kind');
  if (new Set(actorList).size !== actorList.length) fail('actors must be distinct');
  for (const actor of actorList) {
    if (!(AUDIT_ACTOR_KINDS as readonly unknown[]).includes(actor)) fail('unknown actor kind');
  }
  const before = checkFields('before', declaration.before);
  const after = checkFields('after', declaration.after);
  if (actorList.includes('anonymous') && after?.[BOUND_SUBJECT_FIELD]?.kind !== 'id') {
    fail(`an action open to anonymous must declare the after field ${BOUND_SUBJECT_FIELD}: id`);
  }

  const definition = Object.freeze({
    action,
    owner,
    targetType,
    targetId,
    actors: Object.freeze([...actorList].sort()),
    before,
    after,
    // Frozen too, so the definition is frozen all the way down (Hassan L3).
    entry: Object.freeze(
      (target: AuditTargetValue<T>, values: AuditEntryValues<B, F>): AuditEntry<A> => {
        const given = (values ?? {}) as { readonly before?: unknown; readonly after?: unknown };
        return Object.freeze({
          action,
          targetType,
          targetId: target,
          before: given.before ?? null,
          after: given.after ?? null,
        });
      },
    ),
  }) as unknown as AuditActionDefinition<A, B, F, T>;
  DEFINED.add(definition);
  return definition;
}

// ---------------------------------------------------------------------------------------------
// Validation and the jsonb form

/** Why one side of an entry was refused: a code and, for a declared field, its name. */
export interface AuditFieldsError {
  readonly code: 'audit-fields.invalid';
  /** `null` for `not-an-object` and `undeclared`: an undeclared key is caller data. */
  readonly field: string | null;
  readonly problem: 'not-an-object' | 'undeclared' | 'missing' | 'invalid' | 'too-long';
}

export interface AuditFieldCheckOptions {
  /** True for a key of the `PermissionRegistry` or its retired list (foundations 6.1). */
  readonly isKnownPermissionKey: (key: string) => boolean;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

/**
 * The jsonb form of a `money` value: `{amount, currency}` with the amount as a digit string, so
 * the row and its hash never hold a float or a bigint. Each property is read once, and only the
 * primitives read are checked and written (Hassan L1, L2), so a getter or a Proxy cannot answer
 * the checks with one value and the row with another. The amount is above zero and is written
 * by the same rule `parseMinorUnits` reads (digits, no sign, no leading zero, at most 16); the
 * currency is an ISO 4217 code known to the platform. Nothing else of the value is written.
 */
function moneyJson(value: unknown): JsonObject | undefined {
  let amount: unknown;
  let currency: unknown;
  try {
    // Own properties only: an `amount` or `currency` put on Object.prototype is not the value's
    // (Hassan L1 on the money kind).
    if (
      !isPlainObject(value) ||
      !Object.hasOwn(value, 'amount') ||
      !Object.hasOwn(value, 'currency')
    ) {
      return undefined;
    }
    amount = value.amount;
    currency = value.currency;
  } catch {
    return undefined;
  }
  if (typeof amount !== 'bigint' || amount < 1n) return undefined;
  const digits = amount.toString(10);
  if (!parseMinorUnits(digits, MAX_WIRE_AMOUNT_DIGITS).ok) return undefined;
  const parsed = parseMoney(amount, currency);
  if (!parsed.ok) return undefined;
  return { amount: digits, currency: parsed.value.currency };
}

type Encoded =
  | { readonly ok: true; readonly value: JsonValue }
  | { readonly ok: false; readonly tooLong?: true };
const invalid: Encoded = { ok: false };

function encodePlain(kind: AuditPlainKind, value: unknown, options: AuditFieldCheckOptions) {
  switch (kind.kind) {
    case 'id':
      return typeof value === 'string' && parseId(value).ok
        ? { ok: true as const, value }
        : invalid;
    case 'enumOf':
      return typeof value === 'string' && kind.values.includes(value)
        ? { ok: true as const, value }
        : invalid;
    case 'boolean':
      return typeof value === 'boolean' ? { ok: true as const, value } : invalid;
    case 'integer':
      return Number.isSafeInteger(value) ? { ok: true as const, value: value as number } : invalid;
    case 'instant': {
      // Whole milliseconds, written with exactly three fractional digits, like occurredAt;
      // through the prototype's own methods, so a subclass cannot choose the text (Hassan L1).
      const text = instantText(value, true);
      return text === undefined ? invalid : { ok: true as const, value: text };
    }
    case 'permissionKey':
      return typeof value === 'string' && options.isKnownPermissionKey(value)
        ? { ok: true as const, value }
        : invalid;
    case 'money': {
      const json = moneyJson(value);
      return json === undefined ? invalid : { ok: true as const, value: json };
    }
  }
}

function encodeValue(kind: AuditFieldKind, value: unknown, options: AuditFieldCheckOptions) {
  if (kind.kind === 'listOf') {
    if (!Array.isArray(value)) return invalid;
    // One copy, taken first, is checked and encoded (Hassan L2): a Proxy or an accessor cannot
    // answer the length check with one list and the encoding with another. The length is read
    // once and refused above the maximum before anything is copied, and the copy is an index
    // loop into a fresh array: `slice` would honour `Symbol.species` (Hassan R1 on slice 6a).
    const copied = copyListOnce(value, kind.max);
    if (copied === undefined) return invalid;
    if (!('copy' in copied)) return { ok: false, tooLong: true } as Encoded;
    const copy = copied.copy;
    const items: JsonValue[] = [];
    for (let index = 0; index < copy.length; index += 1) {
      const encoded = encodePlain(kind.of, copy[index], options);
      if (!encoded.ok) return invalid;
      items.push(encoded.value);
    }
    return { ok: true, value: items } as Encoded;
  }
  if (kind.kind === 'optional') {
    return value === null
      ? ({ ok: true, value: null } as Encoded)
      : encodePlain(kind.of, value, options);
  }
  return encodePlain(kind, value, options);
}

/**
 * Checks one side of an entry against its declared fields and returns its jsonb form: exactly
 * the declared fields, each of its kind; instants as RFC 3339 UTC with three fractional digits;
 * money as `{amount: "<digits>", currency}`; `null` for an absent optional. A list longer than its maximum is `too-long`. The AuditWriter
 * runs it on every entry (PA W4), whatever the definition's `entry` did.
 */
export function encodeAuditFields(
  fields: AuditFields,
  values: unknown,
  options: AuditFieldCheckOptions,
): Result<JsonObject, AuditFieldsError> {
  const refuse = (field: string | null, problem: AuditFieldsError['problem']) =>
    err<AuditFieldsError>({ code: 'audit-fields.invalid', field, problem });
  if (!isPlainObject(values)) return refuse(null, 'not-an-object');
  for (const name of Object.keys(values)) {
    if (!Object.hasOwn(fields, name)) return refuse(null, 'undeclared');
  }
  const encoded: Record<string, JsonValue> = {};
  for (const [name, kind] of Object.entries(fields)) {
    if (!Object.hasOwn(values, name)) return refuse(name, 'missing');
    const value = values[name];
    if ((value === undefined || value === null) && kind.kind !== 'optional') {
      return refuse(name, 'missing');
    }
    const result = encodeValue(kind, value, options);
    if (!result.ok) return refuse(name, result.tooLong === true ? 'too-long' : 'invalid');
    encoded[name] = result.value;
  }
  return ok(encoded);
}

// ---------------------------------------------------------------------------------------------
// The catalogue snapshot

function describeKind(kind: AuditFieldKind): string {
  switch (kind.kind) {
    case 'enumOf':
      return `enumOf(${kind.values.join('|')})`;
    case 'listOf':
      return `listOf(${describeKind(kind.of)}, max ${kind.max})`;
    case 'optional':
      return `optional(${describeKind(kind.of)})`;
    default:
      return kind.kind;
  }
}

/** One entry of the audit action catalogue snapshot (PA 3.2): what Hassan reads in a diff. */
export interface AuditActionDescription {
  readonly action: string;
  readonly targetType: string;
  readonly targetId: string;
  readonly actors: readonly AuditActorKind[];
  readonly before: Readonly<Record<string, string>> | null;
  readonly after: Readonly<Record<string, string>> | null;
}

function describeFields(fields: AuditFields | null): Record<string, string> | null {
  if (fields === null) return null;
  return Object.fromEntries(
    Object.keys(fields)
      .sort()
      .map((name) => [name, describeKind(fields[name]!)]),
  );
}

export function describeAuditAction(definition: AuditActionDefinition): AuditActionDescription {
  return {
    action: definition.action,
    targetType: definition.targetType,
    targetId: describeKind(definition.targetId),
    actors: [...definition.actors],
    before: describeFields(definition.before),
    after: describeFields(definition.after),
  };
}
