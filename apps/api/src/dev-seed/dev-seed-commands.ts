import type { Id } from '@mondapac-drive/shared-kernel';
import { DeliveryRecipients } from '../modules/delivery';
import { IDENTITY_OPERATOR_COMMANDS } from '../modules/identity';
import type { OperatorCommand } from '../platform/operator/operator-command';

/**
 * The operator commands the dev seed runs as the Market's SYSTEM actor, through the platform's
 * operator runner (so the seed never mints a context): identity's `first-admin`, and
 * `delivery-pin`, which reads the recipient PIN of the delivery the seed assigned, the code the
 * recipient would get by SMS, so the smoke run can prove delivery with it. Neither exists in an
 * api or worker image's commands; the seed's own process is the only caller.
 */
export const DEV_SEED_COMMANDS: readonly OperatorCommand[] = Object.freeze([
  ...IDENTITY_OPERATOR_COMMANDS.filter((command) => command.name === 'first-admin'),
  {
    name: 'delivery-pin',
    flags: ['delivery'],
    async run(app, context, values) {
      const found = await app
        .get(DeliveryRecipients, { strict: false })
        .forNotification(context, values.delivery as Id<'Delivery'>);
      return found?.recipientPin
        ? { done: true, body: { outcome: 'pin.read', pin: found.recipientPin } }
        : { done: false, body: { outcome: 'delivery.not-found' } };
    },
  },
]);
