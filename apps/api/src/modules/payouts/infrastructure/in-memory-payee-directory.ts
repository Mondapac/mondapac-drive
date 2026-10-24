import type { CallContext, MarketId } from '@mondapac-drive/shared-kernel';
import type { PayeeDirectory } from '../application/ports';
import type { Payee } from '../domain/payee';

/** A {@link PayeeDirectory} held in memory, for tests: they add the couriers they need. */
export class InMemoryPayeeDirectory implements PayeeDirectory {
  readonly #payees = new Map<string, Payee>();

  add(marketId: MarketId, payee: Payee): void {
    this.#payees.set(`${marketId}/${payee.courierId}`, Object.freeze({ ...payee }));
  }

  payees(context: CallContext, courierIds: readonly string[]) {
    const { market } = context;
    const found = new Map<string, Payee>();
    for (const courierId of courierIds) {
      const payee = this.#payees.get(`${market.marketId}/${courierId}`);
      if (payee !== undefined) found.set(courierId, payee);
    }
    return Promise.resolve(found as ReadonlyMap<string, Payee>);
  }
}
