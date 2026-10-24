import { err, ok, parseId, Temporal } from '@mondapac-drive/shared-kernel';
import type {
  FieldKind,
  JsonObject,
  JsonValue,
  PayloadFields,
  Result,
} from '@mondapac-drive/shared-kernel';

/**
 * A decoded payload, untyped: it has the shape of `PayloadOf<F>` for the `fields` it was decoded
 * against; `subscription()` gives it that type for the handler.
 */
export type DecodedPayload = Readonly<Record<string, unknown>>;

/** A stored payload that does not match its definition: the field's name, never a value. */
export interface PayloadDecodeError {
  readonly code: 'event-payload.undecodable';
  readonly field: string | null;
}

type Decoded = { readonly ok: true; readonly value: unknown } | { readonly ok: false };
const invalid: Decoded = { ok: false };

function decodeValue(kind: FieldKind, value: JsonValue | undefined): Decoded {
  switch (kind.kind) {
    case 'id':
    case 'permissionKey':
      return typeof value === 'string' && (kind.kind !== 'id' || parseId(value).ok)
        ? { ok: true, value }
        : invalid;
    case 'enumOf':
      return typeof value === 'string' && kind.values.includes(value)
        ? { ok: true, value }
        : invalid;
    case 'boolean':
      return typeof value === 'boolean' ? { ok: true, value } : invalid;
    case 'integer':
      return Number.isSafeInteger(value) ? { ok: true, value } : invalid;
    case 'instant': {
      if (typeof value !== 'string') return invalid;
      try {
        return { ok: true, value: Temporal.Instant.from(value) };
      } catch {
        return invalid;
      }
    }
    case 'listOf': {
      if (!Array.isArray(value)) return invalid;
      const items: unknown[] = [];
      for (const item of value as readonly JsonValue[]) {
        const decoded = decodeValue(kind.of, item);
        if (!decoded.ok) return invalid;
        items.push(decoded.value);
      }
      return { ok: true, value: Object.freeze(items) };
    }
    case 'optional':
      return value === null || value === undefined
        ? { ok: true, value: null }
        : decodeValue(kind.of, value);
  }
}

/**
 * The typed payload of a consumed event (platform persistence design 6.4): the reverse of the
 * kernel's `encodePayload`, against the subscriber's definition. Exactly the declared fields,
 * each of its kind; instants back to `Temporal.Instant`. A payload that does not match is a
 * broken invariant (the outbox writer checked it on the way in), so the dispatcher dead-letters
 * the delivery instead of guessing.
 */
export function decodePayload(
  fields: PayloadFields,
  payload: JsonObject,
): Result<DecodedPayload, PayloadDecodeError> {
  for (const name of Object.keys(payload)) {
    if (!Object.hasOwn(fields, name)) {
      return err({ code: 'event-payload.undecodable', field: null });
    }
  }
  const decoded: Record<string, unknown> = {};
  for (const [name, kind] of Object.entries(fields)) {
    const result = decodeValue(kind, payload[name]);
    if (!result.ok) return err({ code: 'event-payload.undecodable', field: name });
    decoded[name] = result.value;
  }
  return ok(Object.freeze(decoded));
}
