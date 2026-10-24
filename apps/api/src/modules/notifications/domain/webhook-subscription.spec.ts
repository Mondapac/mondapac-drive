import { Temporal } from '@mondapac-drive/shared-kernel';
import { TEST_MARKET_IDS } from '../../../../test/support/test-config';
import {
  changeEventTypes,
  createSubscription,
  disableSubscription,
  MAX_ROTATION_OVERLAP_SECONDS,
  rotateSecret,
  signingSecretVersions,
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

  const now = Temporal.Instant.from('2026-11-03T00:00:00Z');

  it('rotates to the next secret version, the previous one signing until the overlap ends', () => {
    const rotated = rotateSecret(subscription, now, 600);
    expect(rotated).toMatchObject({
      secretVersion: 2,
      version: 2,
      previousSecretValidUntil: now.add({ seconds: 600 }),
    });
    expect(signingSecretVersions(subscription, now)).toEqual([1]);
    expect(signingSecretVersions(rotated, now)).toEqual([2, 1]);
    expect(signingSecretVersions(rotated, now.add({ seconds: 599 }))).toEqual([2, 1]);
    expect(signingSecretVersions(rotated, now.add({ seconds: 600 }))).toEqual([2]);
  });

  it('signs with at most two secrets: a second rotation inside the overlap ends the oldest', () => {
    const twice = rotateSecret(rotateSecret(subscription, now, 600), now.add({ seconds: 10 }), 600);
    expect(signingSecretVersions(twice, now.add({ seconds: 20 }))).toEqual([3, 2]);
  });

  it('ends the old secret at once with no overlap, and refuses an overlap out of range', () => {
    const rotated = rotateSecret(subscription, now, 0);
    expect(rotated.previousSecretValidUntil).toBeNull();
    expect(signingSecretVersions(rotated, now)).toEqual([2]);
    expect(() => rotateSecret(subscription, now, -1)).toThrow(RangeError);
    expect(() => rotateSecret(subscription, now, MAX_ROTATION_OVERLAP_SECONDS + 1)).toThrow(
      RangeError,
    );
  });

  it('changes event types to a sorted set; the same set changes nothing', () => {
    const changed = changeEventTypes(subscription, ['delivery.cancelled', 'delivery.booked']);
    expect(changed).toMatchObject({
      eventTypes: ['delivery.booked', 'delivery.cancelled'],
      version: 2,
    });
    expect(changeEventTypes(changed, ['delivery.booked', 'delivery.cancelled'])).toBe(changed);
    expect(() => changeEventTypes(subscription, [])).toThrow(/at least one/);
    expect(() => changeEventTypes(disableSubscription(subscription), ['delivery.booked'])).toThrow(
      /disabled/,
    );
  });

  it('refuses to rotate a disabled subscription, and disabling twice changes nothing', () => {
    const disabled = disableSubscription(subscription);
    expect(() => rotateSecret(disabled, now, 600)).toThrow(/disabled/);
    expect(disableSubscription(disabled)).toBe(disabled);
  });

  it('refuses a subscription without event types', () => {
    expect(() => createSubscription({ ...subscription, eventTypes: [] })).toThrow(/at least one/);
  });
});
