import type { Temporal } from '@mondapac-drive/shared-kernel';
import { nextId, T0 } from '../../../../test/support/fleet-markets';
import { TEST_MARKET_IDS } from '../../../../test/support/test-config';
import { activeDeliveryOf, followJob, type CourierJob, type DeliveryReport } from './courier-job';

const code = (code: string) => expect.objectContaining({ code }) as Error;

// Fleet's view of a delivery a courier carries, from delivery's events (handoff 31). The rule
// knows no Market; it runs for each fixture so a Market-shaped assumption would show.
describe.each(TEST_MARKET_IDS)('courier jobs in market %s', () => {
  const courierA: string = nextId<'Account'>();
  const courierB: string = nextId<'Account'>();
  const T1 = T0.add({ minutes: 5 });
  const T2 = T0.add({ minutes: 10 });

  function reports(deliveryId = nextId<'Delivery'>()) {
    let version = 1;
    return (status: string, courierAccountId: string | null, occurredAt = T0): DeliveryReport => {
      version += 1;
      return { deliveryId, deliveryVersion: version, status, courierAccountId, occurredAt };
    };
  }

  /** Applies the reports in order, each at the next instant. */
  function follow(...steps: DeliveryReport[]): CourierJob {
    let job: CourierJob | undefined;
    steps.forEach((step) => {
      job = followJob(job, step);
    });
    return job!;
  }

  it('holds the job for the assigned courier until delivered, then keeps no courier', () => {
    const next = reports();
    const assigned = next('assigned', courierA);
    const job = followJob(undefined, assigned);
    expect(job).toEqual({
      deliveryId: assigned.deliveryId,
      courierAccountId: courierA,
      assignedAt: T0,
      ended: false,
      deliveryVersion: 2,
    });

    // The same courier keeps the time they were given it.
    const atPickup = followJob(job, next('at-pickup', courierA, T1));
    expect(atPickup).toMatchObject({ courierAccountId: courierA, assignedAt: T0 });

    const steps = ['picked-up', 'at-dropoff', 'delivered'].reduce(
      (current, status) => followJob(current, next(status, courierA, T2)),
      atPickup,
    );
    expect(steps).toEqual({
      deliveryId: assigned.deliveryId,
      ended: true,
      deliveryVersion: 6,
    });
  });

  it('keeps the courier through a failed delivery until the parcel is returned', () => {
    const next = reports();
    const failed = follow(
      next('assigned', courierA),
      next('at-pickup', courierA),
      next('picked-up', courierA),
      next('delivery-failed', courierA),
      next('returning', courierA),
    );
    expect(failed).toMatchObject({ courierAccountId: courierA, ended: false });

    expect(followJob(failed, next('returned', courierA, T2))).toMatchObject({
      ended: true,
      deliveryVersion: 7,
    });
    expect(followJob(failed, next('returned', courierA, T2)).courierAccountId).toBeUndefined();
  });

  it('frees the courier on an unassign and gives a reassignment to the new courier', () => {
    const next = reports();
    const assigned = follow(next('assigned', courierA));
    const unassigned = followJob(assigned, next('dispatching', null, T1));
    expect(unassigned).toMatchObject({ ended: false, deliveryVersion: 3 });
    expect(unassigned.courierAccountId).toBeUndefined();
    expect(unassigned.assignedAt).toBeUndefined();

    const reassigned = followJob(unassigned, next('assigned', courierB, T2));
    expect(reassigned).toMatchObject({ courierAccountId: courierB, assignedAt: T2 });
  });

  it('ends at a cancel, and never opens again', () => {
    const next = reports();
    const cancelled = follow(next('assigned', courierA), next('cancelled', null));
    expect(cancelled).toMatchObject({ ended: true, deliveryVersion: 3 });
    expect(cancelled.courierAccountId).toBeUndefined();

    expect(followJob(cancelled, next('assigned', courierB, T2))).toBe(cancelled);
  });

  it('changes nothing for a late or repeated event', () => {
    const next = reports();
    const first = next('assigned', courierA);
    const unassign = next('dispatching', null);
    const job = followJob(followJob(undefined, first), unassign);

    expect(followJob(job, { ...unassign, occurredAt: T2 })).toBe(job);
    expect(followJob(job, { ...first, occurredAt: T2 })).toBe(job);
  });

  it('starts from whatever event it hears first', () => {
    // A delivery assigned before fleet followed delivery's events: its next step opens the job.
    const next = reports();
    next('assigned', courierA);
    expect(followJob(undefined, next('picked-up', courierA, T1))).toMatchObject({
      courierAccountId: courierA,
      assignedAt: T1,
      ended: false,
    });
  });

  it('refuses a report it cannot trust', () => {
    const deliveryId = nextId<'Delivery'>();
    const good: DeliveryReport = {
      deliveryId,
      deliveryVersion: 2,
      status: 'assigned',
      courierAccountId: courierA,
      occurredAt: T0,
    };
    expect(() => followJob(undefined, { ...good, deliveryVersion: 0 })).toThrow(
      code('fleet.job.version-invalid'),
    );
    expect(() => followJob(undefined, { ...good, deliveryVersion: 1.5 })).toThrow(
      code('fleet.job.version-invalid'),
    );
    expect(() => followJob(undefined, { ...good, courierAccountId: '' })).toThrow(
      code('fleet.job.courier-invalid'),
    );
    expect(() => followJob(undefined, { ...good, courierAccountId: 'not-an-account-id' })).toThrow(
      code('fleet.job.courier-invalid'),
    );
    const job = followJob(undefined, good);
    expect(() =>
      followJob(job, { ...good, deliveryId: nextId<'Delivery'>(), deliveryVersion: 3 }),
    ).toThrow(code('fleet.job.delivery-mismatch'));
  });

  describe('the active delivery', () => {
    const open = (at: Temporal.Instant, deliveryId = nextId<'Delivery'>()): CourierJob => ({
      deliveryId,
      courierAccountId: courierA,
      assignedAt: at,
      ended: false,
      deliveryVersion: 2,
    });

    it('is none without an open job', () => {
      expect(activeDeliveryOf([])).toBeUndefined();
      const done: CourierJob = {
        deliveryId: nextId<'Delivery'>(),
        ended: true,
        deliveryVersion: 6,
      };
      const unassigned: CourierJob = {
        deliveryId: nextId<'Delivery'>(),
        ended: false,
        deliveryVersion: 3,
      };
      expect(activeDeliveryOf([done, unassigned])).toBeUndefined();
    });

    it('is the job given first, then the lower delivery id', () => {
      const later = open(T1);
      const first = open(T0);
      expect(activeDeliveryOf([later, first])).toBe(first.deliveryId);

      const [low, high] = [nextId<'Delivery'>(), nextId<'Delivery'>()].sort();
      expect(activeDeliveryOf([open(T0, high), open(T0, low)])).toBe(low);
    });
  });
});
