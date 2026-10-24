import type { DeliveryContact, DeliveryContacts } from '../application/ports';

/**
 * STAND-IN until package 21 merges `DeliveryRecipients.forNotification` into the delivery
 * module's index.ts: it knows no delivery, so every delivery event is refused and retried
 * (nothing is queued) and every SMS dies with `sms.recipient-invalid`. On the rebase after 21
 * this file is replaced by an adapter over that read.
 */
export class NoDeliveryContacts implements DeliveryContacts {
  contactOf(): Promise<DeliveryContact | undefined> {
    return Promise.resolve(undefined);
  }
}
