import type { DeliveryLink } from '../application/ports';

/**
 * The {@link DeliveryLink} until work package 2 exports delivery's use cases through
 * `modules/delivery/index.ts`: it records nothing. The outbox events of dispatch carry the
 * facts, so the delivery can be brought up to date once the link exists.
 */
export class UnlinkedDelivery implements DeliveryLink {
  dispatchOpened(): Promise<void> {
    return Promise.resolve();
  }

  courierAssigned(): Promise<void> {
    return Promise.resolve();
  }
}
