import { ok, Temporal, type Id } from '@mondapac-drive/shared-kernel';
import { testCallContext, testMarketContext } from '@mondapac-drive/shared-kernel/testing';
import { TEST_MARKET_IDS } from '../../../../../test/support/test-config';
import type { EventDelivery } from '../../../../platform/events/event-delivery';
import type { SubscriberContext } from '../../../../platform/events/event-subscriptions';
import type { ForgetPushDevices } from '../../application/use-cases/push-devices.use-case';
import type { SendOfferPush } from '../../application/use-cases/send-offer-push.use-case';
import { pushSubscriptions } from './push.subscriptions';

const offerId = '0195f000-0000-7000-8000-0000000000f1';
const accountId = '0195f000-0000-7000-8000-0000000000a1';
const eventId = '0195f000-0000-7000-8000-0000000000e1' as Id;
const expiresAt = Temporal.Instant.from('2026-11-02T00:01:00Z');

describe.each(TEST_MARKET_IDS)('push subscriptions of notifications in %s', (marketId) => {
  const context = testCallContext(
    testMarketContext(marketId, 'default'),
    'system',
  ) as SubscriberContext;
  const delivery = { eventId, subscriber: 'x', attempt: 1 } as unknown as EventDelivery;

  function wired(answer: 'ok' | 'refuse' = 'ok') {
    const pushed: unknown[] = [];
    const forgotten: unknown[] = [];
    const result = (value: unknown) =>
      Promise.resolve(
        answer === 'ok' ? ok(value) : { ok: false, error: { code: 'push.unavailable' } },
      );
    const send = {
      execute: (_c: unknown, input: unknown) => (
        pushed.push(input),
        result({ pushed: 1, dropped: 0 })
      ),
    } as unknown as SendOfferPush;
    const forget = {
      execute: (_c: unknown, input: unknown) => (forgotten.push(input), result({ removed: 1 })),
    } as unknown as ForgetPushDevices;
    const byName = new Map(pushSubscriptions(send, forget).map((entry) => [entry.name, entry]));
    return { pushed, forgotten, byName };
  }

  it('pushes a sent offer, the offer id from the envelope', async () => {
    const { pushed, byName } = wired();
    await byName.get('notifications.offer-push')!.handle(
      {
        eventId,
        type: 'dispatch.offer-sent.v1',
        aggregateId: offerId,
        payload: { jobId: offerId, deliveryId: offerId, courierId: accountId, round: 1, expiresAt },
      } as never,
      delivery,
      context,
    );
    expect(pushed).toEqual([{ delivery, offerId, courierId: accountId, expiresAt }]);
  });

  it.each([
    ['notifications.disabled-account-sessions', 'identity.account-disabled.v1'],
    ['notifications.password-changed-sessions', 'identity.account-password-changed.v1'],
    ['notifications.signed-out-sessions', 'identity.account-other-sessions-signed-out.v1'],
  ])('%s drops the devices of the account of %s', async (name, type) => {
    const { forgotten, byName } = wired();
    const subscription = byName.get(name)!;
    expect(subscription.event.type).toBe(type);
    await subscription.handle(
      { eventId, type, payload: { accountId } } as never,
      delivery,
      context,
    );
    expect(forgotten).toEqual([{ delivery, accountId }]);
  });

  it('throws on a refusal, so the delivery is retried', async () => {
    const { byName } = wired('refuse');
    await expect(
      byName
        .get('notifications.offer-push')!
        .handle(
          { eventId, aggregateId: offerId, payload: { courierId: accountId, expiresAt } } as never,
          delivery,
          context,
        ),
    ).rejects.toThrow('notifications.offer-push refused: push.unavailable');
  });
});
