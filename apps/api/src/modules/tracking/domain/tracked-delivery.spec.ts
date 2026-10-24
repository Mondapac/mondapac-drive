import { Temporal, type Id } from '@mondapac-drive/shared-kernel';
import {
  followDelivery,
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

describe('following the delivery lifecycle (handoff 26)', () => {
  const courier = '01990000-0000-7000-8000-0000000000c1';
  const other = '01990000-0000-7000-8000-0000000000c2';
  const where = { pickup: route.pickup, dropoff: route.dropoff, vehicle: 'car' as const };
  const booked = () => {
    const started = followDelivery(
      undefined,
      deliveryId,
      { deliveryVersion: 1, status: 'DISPATCHING' },
      where,
      now,
    );
    if (!started.ok) throw new Error('not started');
    return started.value;
  };

  it('starts from the first event and the route delivery gives', () => {
    expect(booked()).toMatchObject({
      status: 'DISPATCHING',
      vehicle: 'car',
      version: 1,
      deliveryVersion: 1,
    });
    expect(booked().courierId).toBeUndefined();
  });

  it('cannot start without a route', () => {
    expect(
      followDelivery(
        undefined,
        deliveryId,
        { deliveryVersion: 1, status: 'SCHEDULED' },
        undefined,
        now,
      ),
    ).toEqual({ ok: false, error: { code: 'tracking.route-unknown' } });
  });

  it('moves the phase and the courier, keeps the vehicle, and records each version', () => {
    const assigned = followDelivery(
      booked(),
      deliveryId,
      { deliveryVersion: 2, status: 'ASSIGNED', courierId: courier },
      undefined,
      later,
    );
    expect(assigned).toMatchObject({
      ok: true,
      value: {
        status: 'ASSIGNED',
        courierId: courier,
        vehicle: 'car',
        version: 2,
        deliveryVersion: 2,
      },
    });
    if (!assigned.ok) return;
    const unassigned = followDelivery(
      assigned.value,
      deliveryId,
      { deliveryVersion: 3, status: 'DISPATCHING', courierId: null },
      undefined,
      later,
    );
    expect(unassigned.ok && unassigned.value.courierId).toBeUndefined();
    expect(unassigned.ok && unassigned.value.status).toBe('DISPATCHING');
  });

  it('keeps the courier when the event says nothing of it', () => {
    const assigned = followDelivery(
      booked(),
      deliveryId,
      { deliveryVersion: 2, status: 'PICKED_UP', courierId: courier },
      undefined,
      later,
    );
    if (!assigned.ok) throw new Error('refused');
    const cancelled = followDelivery(
      assigned.value,
      deliveryId,
      { deliveryVersion: 3, status: 'CANCELLED' },
      undefined,
      later,
    );
    expect(cancelled).toMatchObject({ ok: true, value: { courierId: courier, endedAt: later } });
  });

  it('ignores a late or repeated event, and every event after the end', () => {
    const state = booked();
    const reassigned = followDelivery(
      state,
      deliveryId,
      { deliveryVersion: 3, status: 'ASSIGNED', courierId: other },
      undefined,
      later,
    );
    if (!reassigned.ok) throw new Error('refused');
    const late = followDelivery(
      reassigned.value,
      deliveryId,
      { deliveryVersion: 2, status: 'ASSIGNED', courierId: courier },
      undefined,
      later,
    );
    expect(late).toEqual({ ok: true, value: reassigned.value });
    const delivered = followDelivery(
      reassigned.value,
      deliveryId,
      { deliveryVersion: 4, status: 'DELIVERED', courierId: other },
      undefined,
      later,
    );
    if (!delivered.ok) throw new Error('refused');
    expect(delivered.value.endedAt).toEqual(later);
    const afterEnd = followDelivery(
      delivered.value,
      deliveryId,
      { deliveryVersion: 5, status: 'RETURNING', courierId: other },
      undefined,
      later,
    );
    expect(afterEnd).toEqual({ ok: true, value: delivered.value });
  });

  it('records the version of an event that changes nothing else', () => {
    const state = booked();
    const same = followDelivery(
      state,
      deliveryId,
      { deliveryVersion: 2, status: 'DISPATCHING', courierId: null },
      undefined,
      later,
    );
    expect(same).toMatchObject({ ok: true, value: { version: 2, deliveryVersion: 2 } });
  });

  it('starts a delivery first heard of after a direct report, then follows versions', () => {
    const direct = startTracking({ ...route, status: 'ASSIGNED', courierId: courier }, now);
    const next = followDelivery(
      direct,
      deliveryId,
      { deliveryVersion: 4, status: 'AT_PICKUP' },
      undefined,
      later,
    );
    expect(next).toMatchObject({
      ok: true,
      value: { status: 'AT_PICKUP', courierId: courier, deliveryVersion: 4, version: 2 },
    });
  });
});
