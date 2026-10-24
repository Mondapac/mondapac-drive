import {
  HttpException,
  Injectable,
  StreamableFile,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
  type Type,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { parseId, type Id, type Result } from '@mondapac-drive/shared-kernel';
import type { Response } from 'express';
import type { Observable } from 'rxjs';
import { ZodError } from 'zod';
import { ACCESS_DENIED_STATUS } from '../../../platform/authz';
import { callContextOf } from '../../../platform/call-context/call-context.decorator';
import { ObjectStoreUnavailableError } from '../../../platform/storage/object-store';
import { MAX_DOCUMENT_BYTES } from '../application/use-cases/courier-profile.use-case';

/** The status of each refusal; any other code is a broken domain rule (422). */
const STATUS: Readonly<Record<string, number>> = Object.freeze({
  'fleet.courier.not-found': 404,
  'fleet.document.not-found': 404,
  'fleet.vehicle.not-found': 404,
  'fleet.conflict': 409,
  'fleet.shift.transition-not-allowed': 409,
  'fleet.document.size': 413,
  'fleet.document.media-type': 415,
  ...ACCESS_DENIED_STATUS,
});

interface Refusal {
  readonly code: string;
  readonly message?: string;
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

/**
 * Runs a use case and answers its value, or its refusal as an HTTP error. Object storage that
 * is down answers 503, never a 500 with its reason.
 */
export async function answer<T>(run: () => Promise<Result<T, Refusal>>): Promise<T> {
  let result: Result<T, Refusal>;
  try {
    result = await run();
  } catch (error) {
    if (error instanceof ObjectStoreUnavailableError) throw fail(503, 'fleet.storage-unavailable');
    throw error;
  }
  if (result.ok) return result.value;
  const { code, message } = result.error;
  throw fail(STATUS[code] ?? 422, code, message === undefined ? undefined : { message });
}

/** A path id: a malformed one answers as the missing thing it names. */
export function pathId<K extends string>(raw: string, notFound: string): Id<K> {
  const id = parseId<K>(raw.toLowerCase());
  if (!id.ok) throw fail(404, notFound);
  return id.value;
}

/** Answers a document file for download: never rendered by the browser, never cached. */
export function sendFile(
  res: Response,
  file: { readonly documentId: string; readonly mediaType: string; readonly bytes: Buffer },
): StreamableFile {
  const extension =
    file.mediaType === 'application/pdf' ? 'pdf' : file.mediaType === 'image/png' ? 'png' : 'jpg';
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store');
  // A file opened in the browser anyway runs no script and loads nothing.
  res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
  return new StreamableFile(file.bytes, {
    type: file.mediaType,
    disposition: `attachment; filename="${file.documentId}.${extension}"`,
    length: file.bytes.length,
  });
}

/** The multipart limits of a document upload: one file of at most 10 MB and three short fields. */
const UPLOAD_LIMITS = {
  fileSize: MAX_DOCUMENT_BYTES,
  files: 1,
  fields: 3,
  fieldSize: 128,
  parts: 4,
  headerPairs: 20,
};
/** Room for the multipart boundaries and the three fields around the file. */
const MAX_UPLOAD_REQUEST_BYTES = MAX_DOCUMENT_BYTES + 16 * 1024;

const MultipartDocument: Type<NestInterceptor> = FileInterceptor('file', {
  limits: UPLOAD_LIMITS,
});

/**
 * Reads a courier's document upload (`multipart/form-data`, the file in `file`). Before a byte
 * of the body is read it refuses a caller without a session (401) and a declared length over
 * the limit (413); multer then stops reading at 10 MB, so no more is ever buffered. Multer's
 * refusals answer in the API's `{ statusCode, code }` shape.
 */
@Injectable()
export class DocumentUploadInterceptor implements NestInterceptor {
  readonly #multipart = new MultipartDocument();

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const request = context.switchToHttp().getRequest<{
      id?: unknown;
      headers: Record<string, string | string[] | undefined>;
    }>();
    if (callContextOf(request).actor.kind !== 'authenticated') {
      throw fail(401, 'access.unauthenticated');
    }
    const length = Number(request.headers['content-length']);
    if (Number.isFinite(length) && length > MAX_UPLOAD_REQUEST_BYTES) {
      throw fail(413, 'request.body-too-large');
    }
    if (!String(request.headers['content-type'] ?? '').startsWith('multipart/form-data')) {
      throw fail(415, 'request.body-unsupported');
    }
    try {
      return await this.#multipart.intercept(context, next);
    } catch (error) {
      if (error instanceof HttpException && typeof error.getResponse() !== 'object') throw error;
      if (error instanceof HttpException && !('code' in (error.getResponse() as object))) {
        const status = error.getStatus();
        throw fail(
          status === 413 ? 413 : 400,
          status === 413 ? 'request.body-too-large' : 'request.body-malformed',
        );
      }
      throw error;
    }
  }
}

/** The uploaded file multer read into memory. */
export interface UploadedDocumentFile {
  readonly buffer: Buffer;
  readonly size: number;
}
