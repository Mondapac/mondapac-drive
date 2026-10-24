import type { NextFunction, Request, Response } from 'express';

/**
 * The answer to a body the JSON parser refused (slice 0 item 6). body-parser's own message
 * quotes the body ("Unexpected token … in JSON"), so the answer carries a fixed code only,
 * in the shape of platform-foundations 5.1: `{ statusCode, code }`. The error is handed to the
 * request logger, which logs its type and reason, never its message (item 5).
 */
const CODES: Readonly<Record<number, string>> = {
  400: 'request.body-malformed',
  413: 'request.body-too-large',
  415: 'request.body-unsupported',
};

function statusOf(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const { status, type } = error as { status?: unknown; type?: unknown };
  // body-parser marks its errors with a `type` such as `entity.parse.failed`.
  if (typeof type !== 'string' || typeof status !== 'number') return undefined;
  return status in CODES ? status : 400;
}

export function answerBodyError(
  error: unknown,
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (error instanceof Error) res.err = error;
  const status = statusOf(error);
  if (status === undefined || res.headersSent) {
    next(error);
    return;
  }
  res.status(status).json({ statusCode: status, code: CODES[status] });
}
