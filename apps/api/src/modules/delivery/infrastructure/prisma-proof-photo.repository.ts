import type { Id, MarketContext } from '@mondapac-drive/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type { ProofPhoto, ProofPhotoRepository } from '../application/ports';

/** {@link ProofPhotoRepository} on `delivery.proof_photos`, through the open unit's guarded client. */
export class PrismaProofPhotoRepository implements ProofPhotoRepository {
  constructor(private readonly prisma: PrismaService) {}

  async insert(market: MarketContext, photo: ProofPhoto): Promise<void> {
    await this.prisma.tx(market).deliveryProofPhoto.createMany({
      data: [
        {
          marketId: market.marketId,
          tenantId: market.tenantId,
          id: photo.id,
          deliveryId: photo.deliveryId,
          courierId: photo.courierId,
          mediaType: photo.mediaType,
          sizeBytes: photo.sizeBytes,
          storageKey: photo.storageKey,
          createdAt: new Date(photo.createdAt.epochMilliseconds),
        },
      ],
    });
  }

  countFor(market: MarketContext, deliveryId: Id<'Delivery'>): Promise<number> {
    return this.prisma.tx(market).deliveryProofPhoto.count({
      where: { marketId: market.marketId, tenantId: market.tenantId, deliveryId },
    });
  }

  async belongsTo(
    market: MarketContext,
    deliveryId: Id<'Delivery'>,
    photoId: Id<'ProofPhoto'>,
  ): Promise<boolean> {
    const found = await this.prisma.tx(market).deliveryProofPhoto.count({
      where: { marketId: market.marketId, tenantId: market.tenantId, deliveryId, id: photoId },
    });
    return found === 1;
  }
}
