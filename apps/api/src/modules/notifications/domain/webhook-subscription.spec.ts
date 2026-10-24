import { Temporal } from '@mondapac-drive/shared-kernel';
import { TEST_MARKET_IDS } from '../../../../test/support/test-config';
import {
  createSubscription,
  disableSubscription,
  rotateSecret,
  wants,
} from './webhook-subscription';
import type { WebhookUrl } from './webhook-url';

describe.each(TEST_MARKET_IDS)('webhook subscription in %s', (marketId) => {
  const subscription = createSubscription({
    id: 's1',
    marketId,
    merchantId: 'm1',
    url: 'https://hooks.example.com/' as WebhookUrl,
    eventTypes: ['delivery.status-changed', 'delivery.booked', 'delivery.booked'],
    createdAt: Temporal.Instant.from('2026-11-02T00:00:00Z'),
  });

  it('starts active at secret version 1 with its event types once each', () => {
    expect(subscription).toMatchObject({
      status: 'active',
      secretVersion: 1,
      version: 1,
      eventTypes: ['delivery.booked', 'delivery.status-changed'],
    });
  });

  it('wants only its own event types, and nothing once disabled', () => {
    expect(wants(subscription, 'delivery.booked')).toBe(true);
    expect(wants(subscription, 'delivery.cancelled')).toBe(false);
    expect(wants(disableSubscription(subscription), 'delivery.booked')).toBe(false);
  });

  it('rotates to the next secret version', () => {
    expect(rotateSecret(subscription)).toMatchObject({ secretVersion: 2, version: 2 });
  });

  it('refuses to rotate a disabled subscription, and disabling twice changes nothing', () => {
    const disabled = disableSubscription(subscription);
    expect(() => rotateSecret(disabled)).toThrow(/disabled/);
    expect(disableSubscription(disabled)).toBe(disabled);
  });

  it('refuses a subscription without event types', () => {
    expect(() => createSubscription({ ...subscription, eventTypes: [] })).toThrow(/at least one/);
  });
});
