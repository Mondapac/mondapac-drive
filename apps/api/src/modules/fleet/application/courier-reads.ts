import { err, ok, type CallContext, type Id, type Result } from '@mondapac-drive/shared-kernel';
import { submitDocument, type CourierState } from '../domain/courier';
import type { Temporal } from '@mondapac-drive/shared-kernel';
import type { CourierRef } from './courier-changes';
import {
  MAX_DOCUMENT_BYTES,
  documentPrefix,
  sniffMediaType,
  type DocumentFile,
} from './document-files';
import { courierNotFound, documentNotFound, type FleetFailure } from './failure';
import type { FleetDependencies } from './fleet-dependencies';

// The reads and the document file handling the courier's and the operators' use cases share.
// Every read runs in a read-only unit of the caller's Market; `allowed` is checked against the
// stored courier, and a refused caller is told the courier does not exist.

/** One courier, when `allowed` admits the caller for it. */
export async function readCourier(
  deps: FleetDependencies,
  context: CallContext,
  ref: CourierRef,
  allowed: (courier: CourierState) => boolean,
): Promise<Result<CourierState, FleetFailure>> {
  const found = await deps.unitOfWork.run(
    context.market,
    async () =>
      ok(
        'id' in ref
          ? await deps.couriers.findById(context.market, ref.id)
          : await deps.couriers.findByActorId(context.market, ref.accountId),
      ),
    { readOnly: true },
  );
  if (!found.ok || found.value === undefined || !allowed(found.value)) {
    return err(courierNotFound());
  }
  return ok(found.value);
}

/** The file of one of the courier's documents, read from private object storage. */
export async function readDocumentFile(
  deps: FleetDependencies,
  context: CallContext,
  ref: CourierRef,
  documentId: Id<'CourierDocument'>,
  allowed: (courier: CourierState) => boolean,
): Promise<Result<DocumentFile, FleetFailure>> {
  const courier = await readCourier(deps, context, ref, allowed);
  if (!courier.ok) return courier;
  const document = courier.value.documents.find((d) => d.id === documentId);
  if (document === undefined) return err(documentNotFound());
  const bytes = await deps.files.get(document.fileKey);
  if (bytes === null) return err(documentNotFound());
  return ok({ documentId: document.id, mediaType: document.mediaType, bytes });
}

export interface DocumentUpload {
  /** The Market's code of the document, such as `driver_licence`. */
  readonly type: string;
  readonly vehicleId?: Id<'Vehicle'>;
  readonly expiresAt?: Temporal.Instant;
  readonly file: Buffer;
}

export interface SubmittedCourierDocument {
  readonly courier: CourierState;
  readonly documentId: Id<'CourierDocument'>;
}

/**
 * Stores a document the courier submits for review. The file goes to private object storage
 * first, under a key built here (never taken from the request); the profile keeps only that key.
 * The type is read from the bytes. A refused submission removes the file again; if that fails,
 * the sweep of keys no document names removes it later.
 */
export async function submitCourierDocument(
  deps: FleetDependencies,
  context: CallContext,
  accountId: string,
  input: DocumentUpload,
): Promise<Result<SubmittedCourierDocument, FleetFailure>> {
  if (input.file.length === 0 || input.file.length > MAX_DOCUMENT_BYTES) {
    return err({ code: 'fleet.document.size', message: 'A document file is 1 byte to 10 MB' });
  }
  const mediaType = sniffMediaType(input.file);
  if (mediaType === undefined) {
    return err({ code: 'fleet.document.media-type', message: 'A document is a PDF, JPEG or PNG' });
  }
  const own = (courier: CourierState) => courier.actorId === accountId;
  // The courier is checked before anything is written.
  const owner = await readCourier(deps, context, { accountId }, own);
  if (!owner.ok) return owner;
  const courierId = owner.value.id;

  const documentId = deps.ids.next<'CourierDocument'>();
  const fileKey = `${documentPrefix(context.market.marketId)}/${courierId}/${documentId}`;
  await deps.files.put(fileKey, input.file);
  // A throw leaves the file in place: the commit may have happened, and the sweep checks the
  // rows before it deletes anything.
  const result = await deps.changes.apply(
    context,
    { id: courierId },
    {
      allowed: own,
      decide: (courier, rules, now) =>
        submitDocument(
          courier,
          {
            id: documentId,
            type: input.type,
            ...(input.vehicleId === undefined ? {} : { vehicleId: input.vehicleId }),
            fileKey,
            mediaType,
            ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
          },
          rules,
          now,
        ),
    },
  );
  if (!result.ok) await deps.files.delete(fileKey).catch(() => undefined);
  return result.ok ? ok({ courier: result.value, documentId }) : result;
}
