import type { CallContext } from '@mondapac-drive/shared-kernel';
import type { DeliveryRecipients, DeliveryReferences } from '../../delivery';
import type { DeliveryContact, DeliveryContacts } from '../application/ports';

/**
 * The delivery module's system reads, with the Market's system context of the subscriber or the
 * SMS job. `referenceOf` uses `DeliveryReferences.referenceFor` (merchant and reference only), so
 * the phone is read and the PIN derived only by `contactOf`, for an SMS attempt (Hassan, #50 M1).
 */
export class DeliveryRecipientContacts implements DeliveryContacts {
  constructor(
    private readonly recipients: DeliveryRecipients,
    private readonly references: DeliveryReferences,
  ) {}

  async referenceOf(context: CallContext, deliveryId: string) {
    const found = await this.references.referenceFor(context, deliveryId as never);
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
