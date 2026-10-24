import { Inject, Injectable } from '@nestjs/common';
import type { MarketContext } from '@mondapac-drive/shared-kernel';
import type { LivePosition } from '../../domain/live-position';
import { isCourierId } from '../../domain/location-ping';
import { LIVE_POSITION_STORE, type LivePositionStore } from '../ports';

/** A courier's latest fresh position, or undefined once it has expired (the courier is offline). */
@Injectable()
export class LastKnownPosition {
  constructor(@Inject(LIVE_POSITION_STORE) private readonly positions: LivePositionStore) {}

  async perform(market: MarketContext, courierId: string): Promise<LivePosition | undefined> {
    if (!isCourierId(courierId)) return undefined;
    return this.positions.lastKnown(market.marketId, courierId);
  }
}
