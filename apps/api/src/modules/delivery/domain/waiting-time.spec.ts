import { Temporal } from '@mondapac-drive/shared-kernel';
import type { DeliveryHistoryEntry } from './delivery';
import type { DeliveryEventType, DeliveryStatus } from './delivery-status';
import { waitingSecondsOf } from './waiting-time';

const T0 = Temporal.Instant.from('2026-10-25T10:00:00Z');
const at = (seconds: number) => T0.add({ milliseconds: seconds * 1000 });
const step = (type: DeliveryEventType, status: DeliveryStatus, seconds: number) =>
  ({ type, status, at: at(seconds) }) as DeliveryHistoryEntry;

describe('waitingSecondsOf', () => {
  const delivered = [
    step('dispatch_opened', 'DISPATCHING', 0),
    step('courier_assigned', 'ASSIGNED', 30),
    step('arrived_at_pickup', 'AT_PICKUP', 600),
    step('picked_up', 'PICKED_UP', 900.9),
    step('arrived_at_dropoff', 'AT_DROPOFF', 1800),
    step('delivered', 'DELIVERED', 1920),
  ];

  it('measures each stop from arrival to the next step, in whole seconds', () => {
    expect(waitingSecondsOf(delivered, at(5000))).toEqual({ pickup: 300, dropoff: 120 });
  });

  it('is zero before the courier reaches a stop', () => {
    expect(waitingSecondsOf(delivered.slice(0, 2), at(5000))).toEqual({ pickup: 0, dropoff: 0 });
    expect(waitingSecondsOf([], at(5000))).toEqual({ pickup: 0, dropoff: 0 });
  });

  it('counts an open stay up to now', () => {
    expect(waitingSecondsOf(delivered.slice(0, 3), at(645))).toEqual({ pickup: 45, dropoff: 0 });
    expect(waitingSecondsOf(delivered.slice(0, 5), at(1810))).toEqual({
      pickup: 300,
      dropoff: 10,
    });
  });

  it("counts only the current courier's visit after a reassignment", () => {
    const reassigned = [
      step('courier_assigned', 'ASSIGNED', 0),
      step('arrived_at_pickup', 'AT_PICKUP', 100),
      step('courier_unassigned', 'DISPATCHING', 160),
      step('courier_assigned', 'ASSIGNED', 200),
      step('arrived_at_pickup', 'AT_PICKUP', 400),
      step('picked_up', 'PICKED_UP', 440),
    ];
    expect(waitingSecondsOf(reassigned, at(1000))).toEqual({ pickup: 40, dropoff: 0 });
  });

  it('ends a dropoff stay at a failed delivery, and ignores a clock that went back', () => {
    const failed = [
      step('arrived_at_dropoff', 'AT_DROPOFF', 0),
      step('delivery_failed', 'DELIVERY_FAILED', 90),
    ];
    expect(waitingSecondsOf(failed, at(500))).toEqual({ pickup: 0, dropoff: 90 });
    expect(waitingSecondsOf([step('arrived_at_pickup', 'AT_PICKUP', 100)], at(50))).toEqual({
      pickup: 0,
      dropoff: 0,
    });
  });
});
