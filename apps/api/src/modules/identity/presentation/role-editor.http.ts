import type { HttpException } from '@nestjs/common';
import { parseId } from '@mondapac-drive/shared-kernel';
import type { Id } from '@mondapac-drive/shared-kernel';
import type { Request } from 'express';
import { ACCESS_DENIED_STATUS } from '../../../platform/authz';
import type { PlatformRoleCatalogue } from '../application/use-cases/list-platform-roles.use-case';
import { fail } from './http-body';
import type { RoleCatalogueView } from './role-editor.dto';

// The HTTP adapters of the role editor shared by the admin and the seller controllers (identity
// design 5.2, 8.6; slice 10): the status of each refusal, the closed JSON body, the path id and
// the catalogue as JSON. The design names codes, not statuses.

/**
 * Chosen: a role that is not one of the actor's reach is 404, byte-identical to a missing one; a
 * rule of R1 or R11 the actor does not meet is 403; a state that refuses the change (seeded,
 * held, name taken, limit reached) is 409; a Market without the limit configured is 503.
 */
export const ROLE_EDITOR_STATUS: Readonly<Record<string, number>> = Object.freeze({
  'validation.failed': 400,
  'role.unknown': 404,
  'role.not-grantable': 403,
  'role.read-only': 409,
  'role.in-use': 409,
  'role.name-taken': 409,
  'role.limit': 409,
  'access.unavailable': 503,
});

export type RoleRefusal = { readonly code: string; readonly fields?: readonly unknown[] };

export function roleRefusal(error: RoleRefusal): HttpException {
  const status =
    ROLE_EDITOR_STATUS[error.code] ??
    ACCESS_DENIED_STATUS[error.code as keyof typeof ACCESS_DENIED_STATUS] ??
    500;
  return error.fields === undefined
    ? fail(status, error.code)
    : fail(status, error.code, { fields: error.fields });
}

/** A path id: malformed answers as an unknown role, byte-identical to a missing one (5.2). */
export function rolePathId(raw: string): Id<'Role'> | HttpException {
  const parsed = parseId<'Role'>(raw);
  return parsed.ok ? parsed.value : roleRefusal({ code: 'role.unknown' });
}

const BODY_FIELDS = ['name', 'permissionKeys'] as const;
const MAX_ECHOED = 5;

/**
 * The body of create and edit: JSON only, a closed object with `name` (a string) and
 * `permissionKeys` (an array; the use case checks each element, so no key is echoed). An unknown
 * field name is echoed truncated and capped, as the other closed bodies do.
 */
export function roleBody(
  request: Request,
  body: unknown,
): { name: string; permissionKeys: unknown } | HttpException {
  if (request.is('application/json') !== 'application/json') {
    return fail(415, 'request.body-unsupported');
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return roleRefusal({ code: 'validation.failed', fields: [{ path: '', code: 'type' }] });
  }
  const record = body as Record<string, unknown>;
  const fields: { path: string; code: string }[] = Object.keys(record)
    .filter((key) => !(BODY_FIELDS as readonly string[]).includes(key))
    .sort()
    .slice(0, MAX_ECHOED)
    .map((key) => ({ path: key.slice(0, 32), code: 'unknown-field' }));
  for (const field of BODY_FIELDS) {
    const value = Object.hasOwn(record, field) ? record[field] : undefined;
    if (value === undefined) fields.push({ path: field, code: 'required' });
    else if (field === 'name' && typeof value !== 'string')
      fields.push({ path: field, code: 'type' });
    else if (field === 'permissionKeys' && !Array.isArray(value)) {
      fields.push({ path: field, code: 'type' });
    }
  }
  if (fields.length > 0) return roleRefusal({ code: 'validation.failed', fields });
  return { name: record.name as string, permissionKeys: record.permissionKeys };
}

/** The catalogue as JSON: exactly the declared fields, in a fixed order. */
export function catalogueView(catalogue: PlatformRoleCatalogue): RoleCatalogueView {
  return {
    items: catalogue.items.map((role) => ({
      roleId: role.roleId,
      kind: role.kind,
      seedCode: role.seedCode,
      name: role.name,
      permissionCount: role.permissionCount,
      permissionKeys: [...role.permissionKeys],
      grantable: role.grantable,
      version: role.version,
      actions: { edit: { ...role.actions.edit }, delete: { ...role.actions.delete } },
    })),
    keys: catalogue.keys.map(({ key, protected: isProtected, grantable }) => ({
      key,
      protected: isProtected,
      grantable,
    })),
  };
}
