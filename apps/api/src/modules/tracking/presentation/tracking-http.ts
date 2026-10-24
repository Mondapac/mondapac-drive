import { HttpException } from '@nestjs/common';
import type { Result } from '@mondapac-drive/shared-kernel';
import { ZodError } from 'zod';
import type { TrackingFailure } from '../application/use-cases/view-tracking-link.use-case';

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
});

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

export function answer<T>(result: Result<T, TrackingFailure>): T {
  if (result.ok) return result.value;
  const { code, message, field, retryAfterSeconds } = result.error;
  throw fail(STATUS[code] ?? 422, code, {
    message,
    ...(field === undefined ? {} : { field }),
    ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
  });
}
