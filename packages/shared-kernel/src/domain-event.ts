// Domain events (platform persistence design, "P", 5; platform-foundations 3.6; ADR-0006
// decision 1). The publishing module declares each event with `defineEvent` in its
// `domain/events/` and re-exports it from `contracts/`; its aggregates produce a
// `PendingEvent` with `record`; only the platform's outbox writer turns that into a
// `DomainEvent`, stamping the id, the Market and the correlation id (P 5.1).
//
// Payload fields come from a closed vocabulary (P 5.3): no kind takes an arbitrary string, so
// a reason, a name, an email or a role name cannot be declared (ADR-0009 decision 6, R5). A new
// kind is a kernel change reviewed by the security-tester.
import type { CorrelationId } from './correlation-id';
import { parseId } from './id';
import type { Id } from './id';
import type { MarketContext } from './market-context';
import { err, ok } from './result';
import type { Result } from './result';
import { Temporal } from './time';

// ---------------------------------------------------------------------------------------------
// Field kinds

export interface IdKind {
  readonly kind: 'id';
}
export interface EnumKind<V extends string = string> {
  readonly kind: 'enumOf';
  readonly values: readonly V[];
}
export interface BooleanKind {
  readonly kind: 'boolean';
}
export interface IntegerKind {
  readonly kind: 'integer';
}
export interface InstantKind {
  readonly kind: 'instant';
}
export interface PermissionKeyKind {
  readonly kind: 'permissionKey';
}
export interface ListKind<K extends FieldKind = FieldKind> {
  readonly kind: 'listOf';
  readonly of: K;
}
export interface OptionalKind<K extends FieldKind = FieldKind> {
  readonly kind: 'optional';
  readonly of: K;
}

/** The closed vocabulary of payload field kinds (P 5.3). */
export type FieldKind =
  | IdKind
  | EnumKind
  | BooleanKind
  | IntegerKind
  | InstantKind
  | PermissionKeyKind
  | ListKind
  | OptionalKind;

/** The declared fields of one event: field name to kind. */
export type PayloadFields = Readonly<Record<string, FieldKind>>;

// An enum value is a code, never text: `active`, `seller-owner`, `email.changed`.
const ENUM_VALUE = /^[a-z][a-z0-9-]*(\.[a-z0-9-]+)*$/;
const MAX_ENUM_VALUE_LENGTH = 64;

/** The most values one `enumOf` may declare: a list of codes, never a data set. */
export const MAX_ENUM_VALUES = 256;

/**
 * A plain copy of an array-like list, taken before anything is checked (Hassan R1 and R2 on
 * slice 6a): `length` is read once, then each index once, into a fresh array. No iterator, no
 * `Symbol.species` and no `slice` of the caller's object is used, so a subclass, a stateful
 * iterator or a Proxy cannot answer the checks with one list and the copy with another.
 * Answers `undefined` when the length is not a list length of at most `max`, or a read throws.
 * Internal to the kernel: not exported from index.ts.
 */
export function copyListOnce(
  values: unknown,
  max: number,
): { readonly copy: unknown[] } | { readonly tooLong: true } | undefined {
  try {
    const length: unknown = (values as { readonly length?: unknown }).length;
    if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0) {
      return undefined;
    }
    if (length > max) return { tooLong: true };
    const copy: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      copy.push((values as Readonly<Record<number, unknown>>)[index]);
    }
    return { copy };
  } catch {
    return undefined;
  }
}

function enumOf<const V extends readonly [string, ...string[]]>(values: V): EnumKind<V[number]> {
  // Copy first, then check and freeze that same copy (Hassan R2 on slice 6a).
  const copied = Array.isArray(values) ? copyListOnce(values, MAX_ENUM_VALUES) : undefined;
  if (copied === undefined || !('copy' in copied) || copied.copy.length === 0) {
    throw new TypeError(
      `enumOf: a list of 1 to ${MAX_ENUM_VALUES} values is required, as an array of literals`,
    );
  }
  const copy = copied.copy;
  const seen = new Set<unknown>();
  for (let index = 0; index < copy.length; index += 1) {
    const value = copy[index];
    if (
      typeof value !== 'string' ||
      value.length > MAX_ENUM_VALUE_LENGTH ||
      !ENUM_VALUE.test(value)
    ) {
      throw new TypeError('enumOf: each value must be a lower-case code such as "seller-owner"');
    }
    if (seen.has(value)) throw new TypeError('enumOf: the values must be distinct');
    seen.add(value);
  }
  return Object.freeze({ kind: 'enumOf', values: Object.freeze(copy as V[number][]) });
}

/**
 * The constructors of the vocabulary, and the only way to name a kind. `enumOf` takes literal
 * constants (PH2): write `enumOf(['active', 'disabled'] as const)`.
 */
export const eventField = Object.freeze({
  id: (): IdKind => Object.freeze({ kind: 'id' }),
  enumOf,
  boolean: (): BooleanKind => Object.freeze({ kind: 'boolean' }),
  integer: (): IntegerKind => Object.freeze({ kind: 'integer' }),
  instant: (): InstantKind => Object.freeze({ kind: 'instant' }),
  permissionKey: (): PermissionKeyKind => Object.freeze({ kind: 'permissionKey' }),
  listOf: <K extends FieldKind>(of: K): ListKind<K> => Object.freeze({ kind: 'listOf', of }),
  optional: <K extends FieldKind>(of: K): OptionalKind<K> =>
    Object.freeze({ kind: 'optional', of }),
});

/** The in-memory value of a field of kind `K`, as an aggregate passes it to `record`. */
export type FieldValue<K extends FieldKind> = K extends IdKind
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
            : K extends ListKind<infer Of>
              ? readonly FieldValue<Of>[]
              : K extends OptionalKind<infer Of>
                ? FieldValue<Of> | null
                : never;

/** The payload of an event with fields `F`: every declared field, nothing else. */
export type PayloadOf<F extends PayloadFields> = {
  readonly [Name in keyof F]: FieldValue<F[Name]>;
};

/** A JSON value as stored in `payload jsonb`. */
export type JsonValue = string | number | boolean | null | readonly JsonValue[] | JsonObject;
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

// ---------------------------------------------------------------------------------------------
// Definitions

// `<module>.<subject>-<past participle>.v<N>` (platform-foundations 3.6). The module may hold a
// hyphen (`commission-payouts`); the version has no leading zero.
const EVENT_TYPE = /^([a-z][a-z0-9-]*)\.([a-z0-9]+(?:-[a-z0-9]+)*)\.v([1-9][0-9]*)$/;
// The `aggregate_type` CHECK of every outbox (data design 3.1).
const AGGREGATE_TYPE = /^[a-z][a-z0-9-]*$/;
const FIELD_NAME = /^[a-z][A-Za-z0-9]*$/;

/** The largest aggregate version: the column is a 32-bit integer (P 10). */
export const MAX_AGGREGATE_VERSION = 2 ** 31 - 1;

/** True when `version` fits `aggregate_version`: an integer from 1 to 2^31 - 1. */
export function checkAggregateVersion(version: number): boolean {
  return Number.isInteger(version) && version >= 1 && version <= MAX_AGGREGATE_VERSION;
}

/**
 * What an aggregate records (P 5.1, first two rows): type and aggregate type from the
 * definition; aggregate id, version, instant and payload values from its own state. No event
 * id, Market or correlation id: the outbox writer stamps those.
 */
export interface PendingEvent<T extends string = string, P = Readonly<Record<string, unknown>>> {
  readonly type: T;
  readonly aggregateType: string;
  readonly aggregateId: Id;
  readonly aggregateVersion: number;
  /** The instant the use case took from `Clock`: the one the row's own timestamps get. */
  readonly occurredAt: Temporal.Instant;
  readonly payload: P;
}

export interface RecordInput<F extends PayloadFields> {
  readonly aggregateId: Id;
  readonly aggregateVersion: number;
  readonly occurredAt: Temporal.Instant;
  readonly payload: PayloadOf<F>;
}

export interface EventDefinition<
  T extends string = string,
  F extends PayloadFields = PayloadFields,
> {
  /** The full type, version included: `identity.account-registered.v1`. */
  readonly type: T;
  /** The publishing module: the first segment of the type. */
  readonly module: string;
  readonly version: number;
  readonly aggregateType: string;
  readonly fields: F;
  /** The PendingEvent of this definition. Throws `RangeError` on a version outside 1 to 2^31 - 1. */
  record(input: RecordInput<F>): PendingEvent<T, PayloadOf<F>>;
}

function checkKind(kind: unknown, nested: 'top' | 'optional' | 'list'): void {
  const candidate = kind as Partial<FieldKind> | null;
  switch (candidate?.kind) {
    case 'id':
    case 'boolean':
    case 'integer':
    case 'instant':
    case 'permissionKey':
      return;
    case 'enumOf': {
      const { values } = candidate as EnumKind;
      // Re-check: a kind written as an object literal never went through enumOf.
      enumOf(values as unknown as [string, ...string[]]);
      return;
    }
    case 'listOf':
      if (nested !== 'top') break;
      return checkKind((candidate as ListKind).of, 'list');
    case 'optional':
      if (nested !== 'top') break;
      return checkKind((candidate as OptionalKind).of, 'optional');
    default:
      throw new TypeError('defineEvent: a field kind must come from eventField');
  }
  throw new TypeError('defineEvent: optional and listOf apply to a plain kind only');
}

/**
 * Declares one event (P 5.3). A malformed type, aggregate type, field name or kind is a
 * programmer error and throws `TypeError` when the module loads.
 */
export function defineEvent<const T extends string, const F extends PayloadFields>(declaration: {
  readonly type: T;
  readonly aggregateType: string;
  readonly payload: F;
}): EventDefinition<T, F> {
  const { type, aggregateType, payload } = declaration;
  const parts = typeof type === 'string' ? EVENT_TYPE.exec(type) : null;
  if (parts === null) {
    throw new TypeError('defineEvent: the type must read "<module>.<subject>-<verb>.v<N>"');
  }
  if (typeof aggregateType !== 'string' || !AGGREGATE_TYPE.test(aggregateType)) {
    throw new TypeError(
      'defineEvent: the aggregate type must be a lower-case name such as "account"',
    );
  }
  const fields: Record<string, FieldKind> = {};
  for (const [name, kind] of Object.entries(payload)) {
    if (!FIELD_NAME.test(name)) {
      throw new TypeError('defineEvent: a field name must be camelCase letters and digits');
    }
    checkKind(kind, 'top');
    fields[name] = kind;
  }
  const frozenFields = Object.freeze(fields) as F;

  return Object.freeze({
    type,
    module: parts[1]!,
    version: Number(parts[3]),
    aggregateType,
    fields: frozenFields,
    record(input: RecordInput<F>): PendingEvent<T, PayloadOf<F>> {
      if (!checkAggregateVersion(input.aggregateVersion)) {
        throw new RangeError('record: the aggregate version must be an integer from 1 to 2^31 - 1');
      }
      const payload: unknown = Object.freeze({ ...(input.payload as object) });
      const pending: PendingEvent<T, unknown> = {
        type,
        aggregateType,
        aggregateId: input.aggregateId,
        aggregateVersion: input.aggregateVersion,
        occurredAt: input.occurredAt,
        payload,
      };
      return Object.freeze(pending) as PendingEvent<T, PayloadOf<F>>;
    },
  });
}

// ---------------------------------------------------------------------------------------------
// Validation and the jsonb form

/**
 * Why a payload was refused: a code and, for a declared field, its name; never a value.
 * `field` is `null` for `not-an-object` and `undeclared`: an undeclared key is caller data,
 * so it is never echoed (security review of slice 1b, L2).
 */
export interface EventPayloadError {
  readonly code: 'event-payload.invalid';
  readonly field: string | null;
  readonly problem: 'not-an-object' | 'undeclared' | 'missing' | 'invalid';
}

export interface PayloadCheckOptions {
  /** True for a key of the `PermissionRegistry` or its retired list (foundations 6.1). */
  readonly isKnownPermissionKey: (key: string) => boolean;
}

type Encoded = { readonly ok: true; readonly value: JsonValue } | { readonly ok: false };
const invalid: Encoded = { ok: false };

// Taken once, when the module loads, so a later change to the prototype cannot reach them.
const INSTANT_TO_STRING: (
  this: Temporal.Instant,
  options?: Parameters<Temporal.Instant['toString']>[0],
) => string = Reflect.get(Temporal.Instant.prototype, 'toString');
const INSTANT_EPOCH_NANOSECONDS = Reflect.get(
  Reflect.getOwnPropertyDescriptor(Temporal.Instant.prototype, 'epochNanoseconds')!,
  'get',
) as (this: Temporal.Instant) => bigint;

/**
 * Internal (not exported from the kernel): the RFC 3339 UTC text of a genuine
 * `Temporal.Instant`, through the prototype's own `toString` and `epochNanoseconds`
 * (Hassan L1 on slice 6a), so a subclass or an object that only inherits from the prototype
 * cannot choose its text. `wholeMilliseconds` accepts only a whole millisecond and writes
 * exactly three fractional digits. `undefined` when the value is refused.
 */
export function instantText(value: unknown, wholeMilliseconds: boolean): string | undefined {
  if (!(value instanceof Temporal.Instant)) return undefined;
  try {
    // Both throw a TypeError for an object without the Instant's internal slots.
    const nanoseconds = INSTANT_EPOCH_NANOSECONDS.call(value);
    if (wholeMilliseconds && nanoseconds % 1_000_000n !== 0n) return undefined;
    return wholeMilliseconds
      ? INSTANT_TO_STRING.call(value, { fractionalSecondDigits: 3 })
      : INSTANT_TO_STRING.call(value);
  } catch {
    return undefined;
  }
}

function encodeValue(kind: FieldKind, value: unknown, options: PayloadCheckOptions): Encoded {
  switch (kind.kind) {
    case 'id':
      return typeof value === 'string' && parseId(value).ok ? { ok: true, value } : invalid;
    case 'enumOf':
      return typeof value === 'string' && kind.values.includes(value)
        ? { ok: true, value }
        : invalid;
    case 'boolean':
      return typeof value === 'boolean' ? { ok: true, value } : invalid;
    case 'integer':
      return Number.isSafeInteger(value) ? { ok: true, value: value as number } : invalid;
    case 'instant': {
      const text = instantText(value, false);
      return text === undefined ? invalid : { ok: true, value: text };
    }
    case 'permissionKey':
      return typeof value === 'string' && options.isKnownPermissionKey(value)
        ? { ok: true, value }
        : invalid;
    case 'listOf': {
      if (!Array.isArray(value)) return invalid;
      const items: JsonValue[] = [];
      for (const item of value as unknown[]) {
        const encoded = encodeValue(kind.of, item, options);
        if (!encoded.ok) return invalid;
        items.push(encoded.value);
      }
      return { ok: true, value: items };
    }
    case 'optional':
      return value === null || value === undefined
        ? { ok: true, value: null }
        : encodeValue(kind.of, value, options);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

/**
 * Checks a payload against its declared fields and returns its jsonb form: exactly the
 * declared fields, each of its kind; instants as ISO strings; `null` for an absent optional.
 * The outbox writer runs it on every event (P 5.2), whatever the aggregate did.
 */
export function encodePayload(
  fields: PayloadFields,
  payload: unknown,
  options: PayloadCheckOptions,
): Result<JsonObject, EventPayloadError> {
  const refuse = (field: string | null, problem: EventPayloadError['problem']) =>
    err<EventPayloadError>({ code: 'event-payload.invalid', field, problem });
  if (!isPlainObject(payload)) return refuse(null, 'not-an-object');

  for (const name of Object.keys(payload)) {
    // The key is not declared, so it is caller data: name no field.
    if (!Object.hasOwn(fields, name)) return refuse(null, 'undeclared');
  }
  const encoded: Record<string, JsonValue> = {};
  for (const [name, kind] of Object.entries(fields)) {
    const value = payload[name];
    if ((value === undefined || value === null) && kind.kind !== 'optional') {
      return refuse(name, 'missing');
    }
    const result = encodeValue(kind, value, options);
    if (!result.ok) return refuse(name, 'invalid');
    encoded[name] = result.value;
  }
  return ok(encoded);
}

function describeKind(kind: FieldKind): string {
  switch (kind.kind) {
    case 'enumOf':
      return `enumOf(${kind.values.join('|')})`;
    case 'listOf':
    case 'optional':
      return `${kind.kind}(${describeKind(kind.of)})`;
    default:
      return kind.kind;
  }
}

/** One entry of the event catalogue snapshot (P 5.3): the type, the aggregate type, the fields. */
export interface EventDescription {
  readonly type: string;
  readonly aggregateType: string;
  readonly fields: Readonly<Record<string, string>>;
}

export function describeEventDefinition(definition: EventDefinition): EventDescription {
  return {
    type: definition.type,
    aggregateType: definition.aggregateType,
    fields: Object.fromEntries(
      Object.entries(definition.fields).map(([name, kind]) => [name, describeKind(kind)]),
    ),
  };
}

// ---------------------------------------------------------------------------------------------
// The envelope

/**
 * The envelope of ADR-0006 decision 1, field for field, in camel case, with no actor field
 * (ADR-0018 decision 4; foundations 3.6). Only the outbox writer creates one (from a
 * `PendingEvent`), and only the relay hands one to the event bus.
 */
export interface DomainEvent {
  readonly eventId: Id;
  readonly type: string;
  readonly occurredAt: Temporal.Instant;
  readonly market: MarketContext;
  readonly aggregateType: string;
  readonly aggregateId: Id;
  readonly aggregateVersion: number;
  readonly correlationId: CorrelationId;
  /** The consumed event that caused this one, or `null`. */
  readonly causationId: Id | null;
  /** The jsonb form of the payload; identifiers, codes and permission keys only (P 5.3). */
  readonly payload: JsonObject;
}
