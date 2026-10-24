import type { MarketContext, MarketId } from '@mondapac-drive/shared-kernel';
import type { PayeeDirectory } from '../application/ports';
import type { Payee } from '../domain/payee';

/**
 * A {@link PayeeDirectory} held in memory, until the fleet module (work package 05) publishes
 * its courier profiles: then this binding is replaced by an adapter over fleet's public
 * interface. Empty in a running process, so every courier is unknown and nothing is paid; tests
 * add the couriers they need.
 */
export class InMemoryPayeeDirectory implements PayeeDirectory {
  readonly #payees = new Map<string, Payee>();

  add(marketId: MarketId, payee: Payee): void {
    this.#payees.set(`${marketId}/${payee.courierId}`, Object.freeze({ ...payee }));
  }

  payees(market: MarketContext, courierIds: readonly string[]) {
    const found = new Map<string, Payee>();
    for (const courierId of courierIds) {
      const payee = this.#payees.get(`${market.marketId}/${courierId}`);
      if (payee !== undefined) found.set(courierId, payee);
    }
    return Promise.resolve(found as ReadonlyMap<string, Payee>);
  }
}
