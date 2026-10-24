import { Temporal, type Id } from '@mondapac-drive/shared-kernel';
import { trackingSettings } from '../../../../test/support/tracking-markets';
import { TEST_MARKET_IDS } from '../../../../test/support/test-config';
import { purgeCutoffs } from './breadcrumb';
import type { LivePosition } from './live-position';
import { startTracking, type TrackedStatus } from './tracked-delivery';
import {
  checkLinkOpen,
  customerView,
  issueTrackingLink,
  mayShowCourierPosition,
} from './tracking-link';

const now = Temporal.Instant.from('2026-11-02T00:00:00Z');
const deliveryId = '0195f000-0000-7000-8000-000000000001' as Id<'Delivery'>;
const delivery = (status: TrackedStatus, courierId = 'c-1') =>
  startTracking(
    {
      deliveryId,
      status,
      courierId,
      vehicle: 'van',
      pickup: { lat: -27.47, lng: 153.02 },
      dropoff: { lat: -27.5, lng: 153.05 },
    },
    now,
  );
const courier: LivePosition = {
  courierId: 'c-1',
  point: { lat: -27.481234567, lng: 153.029876543 },
  accuracyMetres: 8,
  recordedAt: now,
};

describe.each(TEST_MARKET_IDS)('tracking link in market %s', (marketId) => {
  const settings = trackingSettings.get(marketId);

  it('expires after the Market link TTL', () => {
    const link = issueTrackingLink(settings, deliveryId, 'a'.repeat(64), now);
    const end = now.add({ hours: settings.trackingLinkTtlHours });
    expect(link.expiresAt).toEqual(end);
    expect(checkLinkOpen(link, end.subtract({ seconds: 1 })).ok).toBe(true);
    expect(checkLinkOpen(link, end)).toEqual({
      ok: false,
      error: { code: 'tracking.link-expired' },
    });
  });

  it('purges breadcrumbs and ended deliveries after the Market retention, and expired links', () => {
    const cutoffs = purgeCutoffs(settings, now);
    expect(cutoffs.breadcrumbsBefore).toEqual(
      now.subtract({ hours: settings.breadcrumbRetentionDays * 24 }),
    );
    expect(cutoffs.deliveriesEndedBefore).toEqual(cutoffs.breadcrumbsBefore);
    expect(cutoffs.linksExpiredBefore).toEqual(now);
  });
});

describe('customer view', () => {
  it('shows the phase only before pickup, even when the courier is known', () => {
    expect(customerView(delivery('ASSIGNED'), courier, 600)).toEqual({
      ok: true,
      value: { phase: 'heading_to_pickup' },
    });
    expect(customerView(delivery('DISPATCHING'), courier, 600)).toEqual({
      ok: true,
      value: { phase: 'awaiting_courier' },
    });
  });

  it('shows the ETA and the rounded courier position from pickup until drop-off', () => {
    expect(customerView(delivery('PICKED_UP'), courier, 600)).toEqual({
      ok: true,
      value: {
        phase: 'on_the_way',
        etaSeconds: 600,
        courier: { lat: -27.4812, lng: 153.0299, recordedAt: now },
      },
    });
    const arriving = customerView(delivery('AT_DROPOFF'), courier, 60);
    expect(arriving.ok && arriving.value.phase).toBe('arriving');
  });

  it('never shows another courier, nor the courier id or accuracy', () => {
    const view = customerView(delivery('PICKED_UP', 'c-2'), courier, 600);
    expect(view).toEqual({ ok: true, value: { phase: 'on_the_way' } });
    const shown = customerView(delivery('PICKED_UP'), courier, 600);
    expect(JSON.stringify(shown)).not.toMatch(/c-1|accuracy/);
  });

  it.each(['DELIVERED', 'CANCELLED', 'RETURNED', 'DELIVERY_FAILED'] as const)(
    'shows nothing once the delivery is %s',
    (status) => {
      expect(customerView(delivery(status), courier, 600)).toEqual({
        ok: false,
        error: { code: 'tracking.ended' },
      });
    },
  );

  it("hides the courier's position while they also carry another delivery past pickup", () => {
    const mine = delivery('PICKED_UP');
    const otherId = '0195f000-0000-7000-8000-000000000002' as Id<'Delivery'>;
    const another = { ...delivery('AT_DROPOFF'), deliveryId: otherId };
    const notYetPicked = { ...delivery('ASSIGNED'), deliveryId: otherId };
    expect(mayShowCourierPosition(mine, [mine])).toBe(true);
    expect(mayShowCourierPosition(mine, [mine, notYetPicked])).toBe(true);
    expect(mayShowCourierPosition(mine, [mine, another])).toBe(false);
    expect(customerView(mine, courier, 600, false)).toEqual({
      ok: true,
      value: { phase: 'on_the_way', etaSeconds: 600 },
    });
  });
});
