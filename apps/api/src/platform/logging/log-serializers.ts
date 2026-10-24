import type { LogFn, Logger } from 'pino';
import { reduceDatabaseError } from '../persistence/database-error';

/**
 * The serializers of every log line, inside a request or outside one (slice 0 item 5,
 * Security L4). They keep what is needed to trace a request and drop what can carry user
 * data or credentials.
 */

/** The request as pino-std-serializers hands it to a custom serializer. */
interface SerializedRequest {
  readonly method: string;
  readonly url: string;
  readonly headers?: Record<string, string | string[] | undefined>;
}

/** What a request is logged as: no headers, no query string, no body. */
export interface LoggedRequest {
  readonly method: string;
  readonly url: string;
  /** The declared size of the body in bytes, when the request declared one. */
  readonly contentLength?: number;
}

/** What an error is logged as: never its message, never the properties it carries. */
export interface LoggedError {
  readonly type: string;
  /** A machine-readable code (`code` of Node and driver errors), when the error has one. */
  readonly code?: string;
  /** body-parser's reason (`entity.parse.failed`, `entity.too.large`, ...). */
  readonly kind?: string;
  /** PostgreSQL's SQLSTATE of a database error (P 12.3), or of a `TransactionConflictError`. */
  readonly sqlState?: string;
  /** The constraint a database error names (P 12.3). */
  readonly constraint?: string;
  /** The `at ...` lines of the stack; the message that heads a stack is left out. */
  readonly stack?: string;
}

function contentLengthOf(headers: SerializedRequest['headers']): number | undefined {
  const value = headers?.['content-length'];
  if (typeof value !== 'string' || !/^\d{1,15}$/.test(value)) return undefined;
  return Number(value);
}

function serializeRequest(req: SerializedRequest): LoggedRequest {
  const contentLength = contentLengthOf(req.headers);
  return {
    method: req.method,
    // Path only: query strings can carry tokens (password reset, verification).
    url: req.url.split('?', 1)[0]!,
    ...(contentLength === undefined ? {} : { contentLength }),
  };
}

function serializeResponse(res: { statusCode: number }): { statusCode: number } {
  return { statusCode: res.statusCode };
}

function stringField(value: unknown, field: string): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const candidate = (value as Record<string, unknown>)[field];
  return typeof candidate === 'string' ? candidate : undefined;
}

/** A name or code is logged only when it looks like one, so it cannot carry free text. */
function tokenField(value: unknown, field: string): string | undefined {
  const candidate = stringField(value, field);
  return candidate !== undefined && /^[A-Za-z0-9_.-]{1,64}$/.test(candidate)
    ? candidate
    : undefined;
}

/**
 * The `at ...` lines of a stack. The stack opens with the message, which can span several
 * lines and can itself hold a line that looks like a frame (a quoted value followed by a
 * newline and `at`). So the header is cut by position first: everything up to the end of
 * the message when the stack carries it, else the first line; only then are frame lines
 * kept.
 */
function framesOf(stack: string | undefined, message: string | undefined): string | undefined {
  if (stack === undefined) return undefined;
  const end = message ? stack.indexOf(message) : -1;
  const body =
    end >= 0
      ? stack.slice(end + message!.length)
      : stack.slice(stack.indexOf('\n') + 1 || stack.length);
  const frames = body
    .split('\n')
    .filter((line) => /^\s+at /.test(line))
    .join('\n');
  return frames || undefined;
}

/**
 * body-parser puts the raw body on its error (`body`) and quotes it in `message`; a
 * database driver error can quote values in `message` and `detail` (identity I15). So an
 * error is logged by its name, its code, body-parser's reason and its stack frames only; a
 * database error also by its SQLSTATE and constraint name, read by the one reducer of
 * platform persistence design 12.3.
 * pino-http hands this the output of pino-std-serializers, which keeps the error itself
 * on `raw`; the root logger hands it the error.
 */
function serializeError(err: unknown): LoggedError {
  const raw: unknown = typeof err === 'object' && err !== null && 'raw' in err ? err.raw : err;
  const name = tokenField(raw, 'name') ?? 'Error';
  const code = tokenField(raw, 'code');
  const kind = tokenField(raw, 'type');
  const frames = framesOf(stringField(raw, 'stack'), stringField(raw, 'message'));
  const database = reduceDatabaseError(raw);
  // A TransactionConflictError carries its SQLSTATE as its only field (P 3.1 row 7).
  const ownSqlState = stringField(raw, 'sqlState');
  const sqlState =
    database?.sqlState ??
    (ownSqlState !== undefined && /^[0-9A-Z]{5}$/.test(ownSqlState) ? ownSqlState : undefined);
  return {
    type: name,
    ...(code === undefined ? {} : { code }),
    ...(kind === undefined ? {} : { kind }),
    ...(sqlState === undefined ? {} : { sqlState }),
    ...(database?.constraint === undefined ? {} : { constraint: database.constraint }),
    ...(frames ? { stack: frames } : {}),
  };
}

/** One set, given to the root logger and to the request logger alike. */
export const LOG_SERIALIZERS = {
  req: serializeRequest,
  res: serializeResponse,
  err: serializeError,
} as const;

/**
 * pino writes an error's `message` as the line's `msg` when the call gives none, which is
 * how Nest's exception handler and `logger.error(error)` log. Such a line gets the error's
 * type as its message instead. A message the code passes itself is kept.
 */
export const LOG_HOOKS = {
  logMethod(this: Logger, args: Parameters<LogFn>, method: LogFn): void {
    const [first, message] = args as unknown[];
    const error: unknown =
      first instanceof Error
        ? first
        : typeof first === 'object' && first !== null
          ? (first as { err?: unknown }).err
          : undefined;
    if (message === undefined && error !== undefined) {
      method.call(this, first as object, serializeError(error).type);
      return;
    }
    method.apply(this, args);
  },
};

/**
 * Serializers apply to their own key only (`err`). An error logged under any other key
 * (`{ error }`, `{ cause }`) would be written with its own properties, a driver error's
 * `detail` among them; so every top-level error value goes through the error serializer.
 */
export const LOG_FORMATTERS = {
  log(object: Record<string, unknown>): Record<string, unknown> {
    // `err` is left to its serializer, which runs after this.
    const isLoose = ([key, value]: [string, unknown]) => key !== 'err' && value instanceof Error;
    if (!Object.entries(object).some(isLoose)) return object;
    return Object.fromEntries(
      Object.entries(object).map((entry) => [
        entry[0],
        isLoose(entry) ? serializeError(entry[1]) : entry[1],
      ]),
    );
  },
};
