import { Catch, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import type { Response } from 'express';
import { StaleAggregateError, TransactionConflictError } from '../unit-of-work/errors';

/** The 409 codes of platform persistence design 10 (they belong to the API error format, I12). */
export const CONFLICT_CODES = {
  stale: 'conflict.stale',
  retry: 'conflict.retry',
} as const;

/**
 * The one platform filter for conflicts (platform persistence design 10, "At the edge"):
 * `StaleAggregateError` answers 409 `conflict.stale`, `TransactionConflictError` (`40001` or
 * `40P01` after three attempts, `55P03` at once) answers 409 `conflict.retry`. The answer has
 * the shape of platform-foundations 5.1, `{ statusCode, code }`, and nothing of the error.
 * A statement timeout (`57014`) is not a conflict and stays a 500.
 */
@Catch(TransactionConflictError, StaleAggregateError)
export class ConflictFilter implements ExceptionFilter {
  catch(exception: TransactionConflictError | StaleAggregateError, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    // An expected outcome under concurrency: the request's completion line records the 409;
    // it is not logged as a server error.
    const code =
      exception instanceof StaleAggregateError ? CONFLICT_CODES.stale : CONFLICT_CODES.retry;
    response.status(409).json({ statusCode: 409, code });
  }
}
