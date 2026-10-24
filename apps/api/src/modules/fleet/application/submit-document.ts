import { Inject, Injectable } from '@nestjs/common';
import {
  err,
  ok,
  type CallContext,
  type Id,
  type IdGenerator,
  type Result,
  type Temporal,
} from '@mondapac-drive/shared-kernel';
import { ID_GENERATOR } from '../../../platform/ids/ids.module';
import { OBJECT_STORE, type ObjectStore } from '../../../platform/storage/object-store';
import { UNIT_OF_WORK, type UnitOfWork } from '../../../platform/unit-of-work/unit-of-work';
import { submitDocument, type CourierState } from '../domain/courier';
import type { DocumentMediaType } from '../domain/documents';
import { isCourierThemself } from './access';
import { CourierChanges } from './courier-changes';
import { courierNotFound, type FleetFailure } from './failure';
import { COURIER_REPOSITORY, type CourierRepository } from './ports';

/** The largest document file: a phone photo or a scanned PDF. */
export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;

export interface SubmitDocumentInput {
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

/** The media type of a file, read from its first bytes rather than from what the client said. */
export function sniffMediaType(file: Buffer): DocumentMediaType | undefined {
  if (file.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  if (file.length >= 3 && file[0] === 0xff && file[1] === 0xd8 && file[2] === 0xff) {
    return 'image/jpeg';
  }
  if (file.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }
  return undefined;
}

/**
 * The courier submits a document for review. The file goes to private object storage first,
 * under a key built here (never taken from the request); the profile keeps only that key. A
 * refused submission removes the file again.
 */
@Injectable()
export class SubmitCourierDocument {
  constructor(
    private readonly changes: CourierChanges,
    @Inject(COURIER_REPOSITORY) private readonly couriers: CourierRepository,
    @Inject(UNIT_OF_WORK) private readonly unitOfWork: UnitOfWork,
    @Inject(OBJECT_STORE) private readonly files: ObjectStore,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
  ) {}

  async execute(
    context: CallContext,
    courierId: Id<'Courier'>,
    input: SubmitDocumentInput,
  ): Promise<Result<SubmittedCourierDocument, FleetFailure>> {
    if (input.file.length === 0 || input.file.length > MAX_DOCUMENT_BYTES) {
      return err({ code: 'fleet.document.size', message: 'A document file is 1 byte to 10 MB' });
    }
    const mediaType = sniffMediaType(input.file);
    if (mediaType === undefined) {
      return err({
        code: 'fleet.document.media-type',
        message: 'A document is a PDF, JPEG or PNG',
      });
    }
    // Only the courier themself stores a file: checked before anything is written.
    const owner = await this.unitOfWork.run(
      context.market,
      async () => ok(await this.couriers.findById(context.market, courierId)),
      { readOnly: true },
    );
    if (!owner.ok || owner.value === undefined || !isCourierThemself(context, owner.value)) {
      return err(courierNotFound());
    }

    const documentId = this.ids.next<'CourierDocument'>();
    const fileKey = `fleet/${context.market.marketId}/${courierId}/${documentId}`;
    await this.files.put(fileKey, input.file);
    let result: Result<CourierState, FleetFailure> | undefined;
    try {
      result = await this.changes.apply(context, courierId, {
        allowed: (courier) => isCourierThemself(context, courier),
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
      });
    } finally {
      if (result === undefined || !result.ok) await this.files.delete(fileKey);
    }
    return result.ok ? ok({ courier: result.value, documentId }) : result;
  }
}
