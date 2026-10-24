import { HttpException } from '@nestjs/common';
import type { Result } from '@mondapac-drive/shared-kernel';
import { ZodError } from 'zod';

/** The status of each refusal; any other code is a broken domain rule (422). */
const STATUS: Readonly<Record<string, number>> = Object.freeze({
  'offer.not-found': 404,
  'offer.not-pending': 409,
  'offer.expired': 410,
  'dispatch.not-found': 404,
  'dispatch.conflict': 409,
  'dispatch.cancelled': 409,
  'dispatch.already-assigned': 409,
  'dispatch.not-exhausted': 409,
  'dispatch.courier-not-active': 422,
  'access.unauthenticated': 401,
  'access.denied': 403,
  'access.unavailable': 503,
});

/** A refusal of a dispatch use case or of the gate in front of it. */
interface Refusal {
  readonly code: string;
  readonly message?: string;
}

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

export function answer<T>(result: Result<T, Refusal>): T {
  if (result.ok) return result.value;
  const { code, message } = result.error;
  throw fail(STATUS[code] ?? 422, code, message === undefined ? undefined : { message });
}
