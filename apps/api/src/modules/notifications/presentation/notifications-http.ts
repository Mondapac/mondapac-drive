import { HttpException } from '@nestjs/common';
import { parseId, type Result } from '@mondapac-drive/shared-kernel';
import { ZodError } from 'zod';
import { ACCESS_DENIED_STATUS } from '../../../platform/authz';

/** The status of each refusal; any other code is a broken domain rule (422). */
const STATUS: Readonly<Record<string, number>> = Object.freeze({
  'webhook-subscription.not-found': 404,
  'webhook-subscription.limit': 409,
  'webhook-subscription.unknown-event-type': 400,
  'webhook-call.not-found': 404,
  'webhook-call.changed': 409,
  'push-device.invalid-token': 400,
  'webhook-subscription.page-limit': 400,
  ...ACCESS_DENIED_STATUS,
});

export function fail(status: number, code: string, details?: object): HttpException {
  return new HttpException({ statusCode: status, code, ...(details ? { details } : {}) }, status);
}

/** Parses a body with zod; a refusal names the fields and issues, never the values. */
export function parsed<T>(parse: () => T): T {
  try {
    return parse();
  } catch (error) {
    if (error instanceof ZodError) {
      throw fail(400, 'validation.failed', {
        fields: error.issues
          .slice(0, 10)
          .map((issue) => ({ path: issue.path.join('.'), code: issue.code })),
      });
    }
    throw error;
  }
}

/**
 * The value of a result, or the HTTP error of its refusal. A refused URL (`webhook-url.*`) is a
 * bad request; its message never repeats the URL.
 */
export function answer<T>(
  result: Result<T, { readonly code: string; readonly message?: string }>,
): T {
  if (result.ok) return result.value;
  const { code, message } = result.error;
  const status = STATUS[code] ?? (code.startsWith('webhook-url.') ? 400 : 422);
  throw fail(status, code, message === undefined ? undefined : { message });
}

/** A path id: a malformed one answers as a missing `what`. */
export function pathId(raw: string, what: 'webhook-subscription' | 'webhook-call'): string {
  const id = parseId(raw.toLowerCase());
  if (!id.ok) throw fail(404, `${what}.not-found`);
  return id.value;
}
