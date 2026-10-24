import type { MarketId } from '@mondapac-drive/shared-kernel';
import { ConcurrentModificationError, type DeliveryRepository } from '../application/ports.js';
import type { DeliveryState } from '../domain/delivery.js';

/**
 * Process-memory store for the first slice and for tests. The PostgreSQL repository over
 * prisma/schema/delivery.prisma replaces it before anything is deployed.
 */
export class InMemoryDeliveryRepository implements DeliveryRepository {
  private readonly rows = new Map<string, DeliveryState>();

  async findById(marketId: MarketId, id: string): Promise<DeliveryState | undefined> {
    const row = this.rows.get(id);
    return row && row.marketId === marketId ? row : undefined;
  }

  async findByExternalReference(
    marketId: MarketId,
    merchantId: string,
    externalReference: string,
  ): Promise<DeliveryState | undefined> {
    return [...this.rows.values()].find(
      (row) =>
        row.marketId === marketId &&
        row.merchantId === merchantId &&
        row.externalReference === externalReference,
    );
  }

  async save(delivery: DeliveryState): Promise<void> {
    const stored = this.rows.get(delivery.id);
    const expected = stored ? stored.version + 1 : 1;
    if (delivery.version !== expected) throw new ConcurrentModificationError(delivery.id);
    this.rows.set(delivery.id, delivery);
  }
}
