import type { CallContext } from '@mondapac-drive/shared-kernel';
import type { DeliveryRecipients } from '../../delivery';
import type { DeliveryContact, DeliveryContacts } from '../application/ports';

/**
 * The delivery module's `DeliveryRecipients.forNotification` (rule `system`), with the Market's
 * system context of the subscriber or the SMS job. `referenceOf` hands on the merchant side
 * only, so the phone and the PIN reach nothing but an SMS attempt.
 */
export class DeliveryRecipientContacts implements DeliveryContacts {
  constructor(private readonly recipients: DeliveryRecipients) {}

  async referenceOf(context: CallContext, deliveryId: string) {
    const found = await this.contactOf(context, deliveryId);
    return found === undefined
      ? undefined
      : { merchantId: found.merchantId, externalReference: found.externalReference };
  }

  async contactOf(context: CallContext, deliveryId: string): Promise<DeliveryContact | undefined> {
    const found = await this.recipients.forNotification(context, deliveryId as never);
    return found === undefined
      ? undefined
      : {
          merchantId: found.merchantId,
          externalReference: found.externalReference,
          dropoffPhone: found.dropoffPhone,
          recipientPin: found.recipientPin,
        };
  }
}
