import { HttpException } from '@nestjs/common';
import type { Result } from '@mondapac-drive/shared-kernel';
import { ZodError } from 'zod';

/** The status of each refusal; any other code is a broken domain rule (422). */
const STATUS: Readonly<Record<string, number>> = Object.freeze({
  'ping.invalid': 400,
  'ping.stale': 422,
  'ping.future': 422,
  'ping.throttled': 429,
  'tracking.invalid': 400,
  'tracking.delivery-not-found': 404,
  'tracking.link-not-found': 404,
  'tracking.link-expired': 410,
  'tracking.ended': 410,
  'tracking.position-not-found': 404,
  'access.unauthenticated': 401,
  'access.denied': 403,
  'access.unavailable': 503,
});

/** A refusal of a tracking use case or of the gate in front of it. */
interface Refusal {
  readonly code: string;
  readonly message?: string;
  readonly field?: string;
  readonly retryAfterSeconds?: number;
}

export function fail(status: number, code: string, details?: object): HttpException {
  return new HttpException({ statusCode: status, code, ...(details ? { details } : {}) }, status);
}

/** Parses a body or query with zod; a refusal names the fields and issues, never the values. */
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
  throw refusal(result.error);
}

/** The HTTP error of a refusal: its status, code and the closed details. */
export function refusal(error: Refusal): HttpException {
  const { code, message, field, retryAfterSeconds } = error;
  const details = {
    ...(message === undefined ? {} : { message }),
    ...(field === undefined ? {} : { field }),
    ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
  };
  return fail(STATUS[code] ?? 422, code, Object.keys(details).length > 0 ? details : undefined);
}
