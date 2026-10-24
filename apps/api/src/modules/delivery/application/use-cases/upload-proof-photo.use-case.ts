import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac-drive/shared-kernel';
import type { CallContext, IdGenerator, Result } from '@mondapac-drive/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import {
  ObjectStoreUnavailableError,
  type ObjectStore,
} from '../../../../platform/storage/object-store';
import { ASSIGNMENT_REPORT } from '../../contracts/permissions';
import type { DeliveryState } from '../../domain/delivery';
import type { DeliveryStatus } from '../../domain/delivery-status';
import { ACCESS_DENIED, courierOf, notFound, type DeliveryAccessDependencies } from '../deliveries';
import type { DeliveryFailure } from '../failure';
import type { ProofPhoto, ProofPhotoMediaType, ProofPhotoRepository } from '../ports';
import type { DeliveryRef } from './merchant-deliveries.use-case';

/** The largest proof photo, in bytes; the route refuses a larger body before buffering it. */
export const MAX_PROOF_PHOTO_BYTES = 5 * 1024 * 1024;
/** The most proof photos one delivery takes. */
export const MAX_PROOF_PHOTOS_PER_DELIVERY = 5;
/** While the parcel is with the courier: a photo is taken at the door. */
const PHOTO_STATUSES: readonly DeliveryStatus[] = ['PICKED_UP', 'AT_DROPOFF'];

export interface UploadProofPhotoInput extends DeliveryRef {
  readonly bytes: Buffer;
}

export interface UploadedProofPhoto {
  /** The reference `delivered` takes as `proof: { kind: 'photo', photoRef }`. */
  readonly photoRef: string;
}

export interface UploadProofPhotoDependencies extends DeliveryAccessDependencies {
  readonly photos: ProofPhotoRepository;
  readonly files: ObjectStore;
  readonly ids: IdGenerator;
}

/** The media type of a photo, read from its first bytes rather than from what the client said. */
export function sniffPhotoType(bytes: Buffer): ProofPhotoMediaType | undefined {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }
  return undefined;
}

/**
 * The courier of a delivery uploads a proof-of-delivery photo while the parcel is with them
 * (picked up or at the drop-off). Rule `permissions [delivery.assignment.report]`; any other
 * delivery answers `delivery.not-found`. The bytes must be a JPEG or a PNG by their first bytes
 * and at most {@link MAX_PROOF_PHOTO_BYTES}; a delivery takes at most
 * {@link MAX_PROOF_PHOTOS_PER_DELIVERY}. The bytes go to private object storage under a key built
 * here (`delivery/<market>/<delivery>/<photo>`), which is never returned: the answer is the
 * photo's id, its `photoRef`. A refused or failed save removes the bytes again.
 */
export class UploadProofPhoto extends UseCase<
  UploadProofPhotoInput,
  UploadedProofPhoto,
  DeliveryFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'delivery.upload-proof-photo',
    rule: { kind: 'permissions', allOf: [ASSIGNMENT_REPORT.key] },
  };

  readonly #logger = new Logger('UploadProofPhoto');

  constructor(
    gate: UseCaseGate,
    private readonly deps: UploadProofPhotoDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: UploadProofPhotoInput,
  ): Promise<Result<UploadedProofPhoto, DeliveryFailure>> {
    const courierId = courierOf(context);
    if (courierId === null) return err(ACCESS_DENIED);
    if (input.bytes.length === 0 || input.bytes.length > MAX_PROOF_PHOTO_BYTES) {
      return err({
        code: 'proof-photo.too-large',
        message: `A proof photo is at most ${MAX_PROOF_PHOTO_BYTES} bytes`,
      });
    }
    const mediaType = sniffPhotoType(input.bytes);
    if (mediaType === undefined) {
      return err({ code: 'proof-photo.unsupported-type', message: 'Send a JPEG or PNG photo' });
    }
    const { market } = context;
    const allowed = (delivery: DeliveryState | undefined): delivery is DeliveryState =>
      delivery !== undefined &&
      delivery.courierId === courierId &&
      PHOTO_STATUSES.includes(delivery.status);

    // Checked before the bytes are stored, so a stranger's upload never reaches storage.
    const checked = await this.deps.unitOfWork.run(
      market,
      async () => ok(await this.deps.deliveries.findById(market, input.deliveryId)),
      { readOnly: true },
    );
    if (!checked.ok || !allowed(checked.value)) return err(notFound(input.deliveryId));

    const photoId = this.deps.ids.next<'ProofPhoto'>();
    const storageKey = `delivery/${market.marketId}/${input.deliveryId}/${photoId}`;
    const photo: ProofPhoto = {
      id: photoId,
      deliveryId: input.deliveryId,
      courierId,
      mediaType,
      sizeBytes: input.bytes.length,
      storageKey,
      createdAt: this.deps.clock.now(),
    };
    try {
      await this.deps.files.put(storageKey, input.bytes);
    } catch (error) {
      if (!(error instanceof ObjectStoreUnavailableError)) throw error;
      return err({
        code: 'proof-photo.storage-unavailable',
        message: 'Photos cannot be stored now; retry, or prove the delivery with the PIN',
      });
    }
    let saved: Result<UploadedProofPhoto, DeliveryFailure>;
    try {
      saved = await this.deps.unitOfWork.run(market, async () => {
        // Read again in the unit: the delivery may have moved on while the bytes were stored.
        if (!allowed(await this.deps.deliveries.findById(market, input.deliveryId))) {
          return err(notFound(input.deliveryId));
        }
        if (
          (await this.deps.photos.countFor(market, input.deliveryId)) >=
          MAX_PROOF_PHOTOS_PER_DELIVERY
        ) {
          return err({
            code: 'proof-photo.limit-reached',
            message: `A delivery takes at most ${MAX_PROOF_PHOTOS_PER_DELIVERY} proof photos`,
          });
        }
        await this.deps.photos.insert(market, photo);
        return ok({ photoRef: photoId });
      });
    } catch (error) {
      await this.deps.files.delete(storageKey);
      throw error;
    }
    if (!saved.ok) {
      await this.deps.files.delete(storageKey);
      return saved;
    }
    this.#logger.log({
      msg: 'delivery.proof-photo.stored',
      deliveryId: input.deliveryId,
      photoId,
      mediaType,
      sizeBytes: photo.sizeBytes,
      marketId: market.marketId,
      correlationId: context.correlationId,
    });
    return saved;
  }
}
