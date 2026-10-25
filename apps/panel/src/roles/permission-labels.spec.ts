import { createTranslator } from 'next-intl';
import { describe, expect, it } from 'vitest';
import messages from '../../messages/en.json';
import { resourceOf } from './role-name.ts';

// The keys a platform role can hold (the admin population of each module's permissions). A role
// editor that falls back to "View" under "Line" leaves an admin guessing what they grant.
const ADMIN_KEYS = [
  'delivery.delivery.view',
  'delivery.delivery.dispatch',
  'delivery.delivery.cancel',
  'dispatch.job.view',
  'dispatch.job.assign',
  'fleet.courier.view',
  'fleet.courier.decide',
  'fleet.document.review',
  'fleet.vehicle.manage',
  'identity.admin-account.view',
  'identity.admin-account.invite',
  'identity.admin-account.disable',
  'identity.admin-account.reset-second-factor',
  'identity.courier-account.view',
  'identity.courier-account.invite',
  'identity.courier-account.disable',
  'identity.merchant.view',
  'identity.merchant.create',
  'identity.merchant.suspend',
  'identity.merchant-api-key.issue',
  'identity.platform-role.view',
  'identity.platform-role.create',
  'identity.platform-role.edit',
  'identity.platform-role.delete',
  'identity.platform-role.assign',
  'notifications.webhook-call.resend',
  'notifications.webhook.view',
  'notifications.webhook.manage',
  'payouts.ledger.view',
  'payouts.line.settle',
  'payouts.adjustment.record',
  'tracking.map.view',
] as const;

describe('permission labels', () => {
  // Keys built at run time, as the role editor builds them.
  const t = createTranslator({ locale: 'en-AU', messages }) as unknown as {
    (key: string): string;
    has: (key: string) => boolean;
  };

  it('names every admin key and its resource in words', () => {
    for (const key of ADMIN_KEYS) {
      expect(t.has(`permission.${key}.label`), key).toBe(true);
      expect(t.has(`permission.resource.${resourceOf(key)}`), key).toBe(true);
    }
  });

  it('gives each resource its own name', () => {
    const names = new Set(ADMIN_KEYS.map((key) => t(`permission.resource.${resourceOf(key)}`)));
    const resources = new Set(ADMIN_KEYS.map(resourceOf));
    expect(names.size).toBe(resources.size);
  });
});
