import { Temporal, type Id } from '@mondapac-drive/shared-kernel';
import {
  phaseOf,
  recordsTrail,
  showsCourierToCustomer,
  startTracking,
  TRACKED_STATUSES,
  updateTracking,
} from './tracked-delivery';

const now = Temporal.Instant.from('2026-11-02T00:00:00Z');
const later = now.add({ minutes: 5 });
const deliveryId = '0195f000-0000-7000-8000-000000000001' as Id<'Delivery'>;
const route = {
  deliveryId,
  pickup: { lat: -27.47, lng: 153.02 },
  dropoff: { lat: -27.5, lng: 153.05 },
};

describe('tracked delivery', () => {
  it('maps every delivery status to a phase, and shows the courier only from pickup to drop-off', () => {
    const shown = TRACKED_STATUSES.filter((status) => showsCourierToCustomer(phaseOf(status)));
    expect(shown).toEqual(['PICKED_UP', 'AT_DROPOFF']);
    expect(phaseOf('DELIVERED')).toBe('ended');
    expect(phaseOf('CANCELLED')).toBe('ended');
    expect(phaseOf('DELIVERY_FAILED')).toBe('ended');
  });

  it('starts at version 1, ended at once when reported in a final status', () => {
    expect(startTracking({ ...route, status: 'DISPATCHING' }, now)).toMatchObject({
      version: 1,
      startedAt: now,
    });
    expect(startTracking({ ...route, status: 'CANCELLED' }, now).endedAt).toEqual(now);
  });

  it('records a new status and courier, and answers the same state for a repeated report', () => {
    const started = startTracking({ ...route, status: 'DISPATCHING' }, now);
    const assigned = updateTracking(
      started,
      { status: 'ASSIGNED', courierId: 'c-1', vehicle: 'car' },
      later,
    );
    expect(assigned).toMatchObject({
      ok: true,
      value: { status: 'ASSIGNED', courierId: 'c-1', vehicle: 'car', version: 2, updatedAt: later },
    });
    if (!assigned.ok) throw new Error('unreachable');
    const again = updateTracking(
      assigned.value,
      { status: 'ASSIGNED', courierId: 'c-1', vehicle: 'car' },
      later.add({ minutes: 1 }),
    );
    expect(again).toEqual({ ok: true, value: assigned.value });
  });

  it('drops the courier when the delivery is unassigned', () => {
    const assigned = startTracking({ ...route, status: 'ASSIGNED', courierId: 'c-1' }, now);
    const back = updateTracking(assigned, { status: 'DISPATCHING' }, later);
    expect(back.ok && back.value.courierId).toBeUndefined();
  });

  it('ends on delivery and refuses every change after that', () => {
    const carried = startTracking({ ...route, status: 'AT_DROPOFF', courierId: 'c-1' }, now);
    const delivered = updateTracking(carried, { status: 'DELIVERED', courierId: 'c-1' }, later);
    expect(delivered.ok && delivered.value.endedAt).toEqual(later);
    if (!delivered.ok) throw new Error('unreachable');
    expect(
      updateTracking(delivered.value, { status: 'AT_DROPOFF', courierId: 'c-1' }, later),
    ).toEqual({ ok: false, error: { code: 'tracking.ended' } });
  });

  it("adds to the trail only for the assigned courier's pings while the delivery is carried", () => {
    const waiting = startTracking({ ...route, status: 'DISPATCHING' }, now);
    const assigned = startTracking({ ...route, status: 'ASSIGNED', courierId: 'c-1' }, now);
    const carried = startTracking({ ...route, status: 'PICKED_UP', courierId: 'c-1' }, now);
    const ended = startTracking({ ...route, status: 'DELIVERED', courierId: 'c-1' }, now);
    expect(recordsTrail(waiting, 'c-1')).toBe(false);
    expect(recordsTrail(assigned, 'c-1')).toBe(true);
    expect(recordsTrail(carried, 'c-1')).toBe(true);
    expect(recordsTrail(carried, 'c-2')).toBe(false);
    expect(recordsTrail(ended, 'c-1')).toBe(false);
  });
});
