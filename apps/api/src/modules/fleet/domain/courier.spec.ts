import {
  applicant,
  asDeclared,
  eligibleApplicant,
  fleetRules,
  IN_A_YEAR,
  nextId,
  T0,
  vehicleInput,
  withVerifiedDocuments,
} from '../../../../test/support/fleet-markets';
import { TEST_MARKET_IDS } from '../../../../test/support/test-config';
import {
  addVehicle,
  approveCourier,
  changeShift,
  deactivateVehicle,
  offboardCourier,
  reinstateCourier,
  rejectDocument,
  revokeDocument,
  submitDocument,
  suspendCourier,
  verifyDocument,
  type CourierState,
} from './courier';
import type { ShiftState } from './shift';

const code = (code: string) => expect.objectContaining({ code }) as Error;

describe.each(TEST_MARKET_IDS)('courier in market %s', (marketId) => {
  const rules = fleetRules.get(marketId);

  /** An approved courier with an eligible van, offline. */
  function activeCourier(): CourierState {
    const { courier } = eligibleApplicant({ marketId });
    return approveCourier(courier, asDeclared(courier), rules, T0).courier;
  }

  function shifts(courier: CourierState, ...states: ShiftState[]): CourierState {
    return states.reduce((c, to) => changeShift(c, to, rules, T0).courier, courier);
  }

  describe('standing', () => {
    it('registers an applicant who is offline, with nothing yet, at version 1', () => {
      const courier = applicant({ marketId });

      expect(courier).toMatchObject({
        marketId,
        status: 'applicant',
        shift: 'offline',
        vehicles: [],
        documents: [],
        version: 1,
      });
    });

    it('approves an applicant only once a vehicle is eligible', () => {
      const withVan = addVehicle(applicant({ marketId }), vehicleInput()).courier;
      expect(() => approveCourier(withVan, asDeclared(withVan), rules, T0)).toThrow(
        code('fleet.courier.not-eligible'),
      );

      const { courier } = eligibleApplicant({ marketId });
      const approved = approveCourier(courier, asDeclared(courier), rules, T0);

      expect(approved.courier.status).toBe('active');
      expect(approved.courier.version).toBe(courier.version + 1);
      expect(approved.events).toEqual([]);
      expect(() =>
        approveCourier(approved.courier, asDeclared(approved.courier), rules, T0),
      ).toThrow(code('fleet.courier.not-an-applicant'));
    });

    it('suspends an online courier, ending the shift, and says so in one event', () => {
      const online = shifts(activeCourier(), 'online');
      const { courier, events } = suspendCourier(online, 'documents', T0);

      expect(courier).toMatchObject({ status: 'suspended', shift: 'offline' });
      expect(events).toEqual([
        expect.objectContaining({
          type: 'fleet.courier-suspended.v1',
          aggregateId: courier.id,
          aggregateVersion: courier.version,
          occurredAt: T0,
          payload: { courierId: courier.id, wasOnline: true },
        }),
      ]);
      expect(() => changeShift(courier, 'online', rules, T0)).toThrow(
        code('fleet.courier.not-active'),
      );
    });

    it('reinstates a suspended courier, who starts offline', () => {
      const suspended = suspendCourier(activeCourier(), 'conduct', T0).courier;
      const { courier } = reinstateCourier(suspended, rules, T0);

      expect(courier).toMatchObject({ status: 'active', shift: 'offline' });
      expect(() => reinstateCourier(courier, rules, T0)).toThrow(
        code('fleet.courier.not-suspended'),
      );
      expect(() => suspendCourier(courier, 'gossip' as never, T0)).toThrow(
        code('fleet.courier.suspension-reason-unknown'),
      );
    });

    it('offboards for good: an online courier goes offline with cause offboarded', () => {
      const online = shifts(activeCourier(), 'online');
      const { courier, events } = offboardCourier(online, T0);

      expect(courier).toMatchObject({ status: 'offboarded', shift: 'offline' });
      expect(events).toEqual([
        expect.objectContaining({
          type: 'fleet.courier-went-offline.v1',
          aggregateVersion: courier.version,
          payload: { courierId: courier.id, cause: 'offboarded' },
        }),
      ]);
      expect(offboardCourier(applicant({ marketId }), T0).events).toEqual([]);
      expect(() => offboardCourier(courier, T0)).toThrow(code('fleet.courier.offboarded'));
      expect(() => addVehicle(courier, vehicleInput())).toThrow(code('fleet.courier.offboarded'));
    });
  });

  describe('shift', () => {
    it('publishes going online and going offline, with the new version', () => {
      const active = activeCourier();
      const online = changeShift(active, 'online', rules, T0);
      const offline = changeShift(online.courier, 'offline', rules, T0);

      expect(online.events).toEqual([
        expect.objectContaining({
          type: 'fleet.courier-went-online.v1',
          aggregateVersion: active.version + 1,
          payload: { courierId: active.id },
        }),
      ]);
      expect(offline.events).toEqual([
        expect.objectContaining({
          type: 'fleet.courier-went-offline.v1',
          aggregateVersion: active.version + 2,
          payload: { courierId: active.id, cause: 'courier' },
        }),
      ]);
    });

    it('publishes nothing for a pause or a delivery, and nothing for no change', () => {
      const online = shifts(activeCourier(), 'online');
      let courier = online;
      for (const to of ['paused', 'online', 'on_delivery', 'online'] as const) {
        const changed = changeShift(courier, to, rules, T0);
        expect(changed.events).toEqual([]);
        courier = changed.courier;
      }
      expect(courier.version).toBe(online.version + 4);
      const same = changeShift(online, 'online', rules, T0);
      expect(same.courier).toBe(online);
      expect(same.events).toEqual([]);
    });

    it('only an active courier works a shift', () => {
      expect(() =>
        changeShift(eligibleApplicant({ marketId }).courier, 'online', rules, T0),
      ).toThrow(code('fleet.courier.not-active'));
    });

    it('finishes a delivery before going offline', () => {
      const delivering = shifts(activeCourier(), 'online', 'on_delivery');
      expect(() => changeShift(delivering, 'offline', rules, T0)).toThrow(
        code('fleet.shift.transition-not-allowed'),
      );
    });

    it('cannot go online once a required document expired, by the Clock', () => {
      const active = activeCourier();
      const later = IN_A_YEAR.add({ hours: 1 });

      expect(() => changeShift(active, 'online', rules, later)).toThrow(
        code('fleet.courier.not-eligible'),
      );
      // A courier already on a delivery may still finish it and come back online.
      const delivering = shifts(active, 'online', 'on_delivery');
      expect(changeShift(delivering, 'online', rules, later).courier.shift).toBe('online');
    });
  });

  describe('vehicles', () => {
    it('refuses a second active vehicle with the same plate', () => {
      const first = vehicleInput({ plate: 'DUP1' });
      const courier = addVehicle(applicant({ marketId }), first).courier;

      expect(() => addVehicle(courier, vehicleInput({ plate: 'dup-1' }))).toThrow(
        code('fleet.vehicle.plate-taken'),
      );
      const retired = deactivateVehicle(courier, first.id).courier;
      expect(addVehicle(retired, vehicleInput({ plate: 'DUP1' })).courier.vehicles).toHaveLength(2);
    });

    it('keeps the vehicle in use during a delivery', () => {
      const delivering = shifts(activeCourier(), 'online', 'on_delivery');
      expect(() => deactivateVehicle(delivering, delivering.vehicles[0]!.id)).toThrow(
        code('fleet.vehicle.in-use'),
      );
      expect(() => deactivateVehicle(delivering, nextId())).toThrow(
        code('fleet.vehicle.not-found'),
      );
    });
  });

  describe('documents', () => {
    const perVehicle = rules.documents.find((d) => d.perVehicle)!;
    const ofCourier = rules.documents.find((d) => !d.perVehicle && d.expires)!;
    const neverExpires = rules.documents.find((d) => !d.expires)!;

    function submit(courier: CourierState, input: Record<string, unknown>) {
      const id = nextId<'CourierDocument'>();
      return submitDocument(
        courier,
        {
          id,
          type: ofCourier.type,
          fileKey: `fleet/${marketId}/${courier.id}/${id}`,
          mediaType: 'image/jpeg',
          expiresAt: IN_A_YEAR,
          ...input,
        } as never,
        rules,
        T0,
      );
    }

    it('refuses a type the Market does not ask for', () => {
      expect(() => submit(applicant({ marketId }), { type: 'library_card' })).toThrow(
        code('fleet.document.type-unknown'),
      );
    });

    it('ties a vehicle document to one of the courier’s vehicles, and a courier document to none', () => {
      const van = vehicleInput();
      const courier = addVehicle(applicant({ marketId }), van).courier;

      expect(() => submit(courier, { type: perVehicle.type })).toThrow(
        code('fleet.document.vehicle-required'),
      );
      expect(() => submit(courier, { type: perVehicle.type, vehicleId: nextId() })).toThrow(
        code('fleet.document.vehicle-required'),
      );
      expect(() => submit(courier, { vehicleId: van.id })).toThrow(
        code('fleet.document.vehicle-not-allowed'),
      );
      const submitted = submit(courier, { type: perVehicle.type, vehicleId: van.id });
      expect(submitted.courier.documents[0]).toMatchObject({
        type: perVehicle.type,
        vehicleId: van.id,
        status: 'submitted',
        submittedAt: T0,
      });
    });

    it('asks an expiry of a document that expires, after now, and none of one that does not', () => {
      const courier = applicant({ marketId });

      expect(() => submit(courier, { expiresAt: undefined })).toThrow(
        code('fleet.document.expiry-required'),
      );
      expect(() => submit(courier, { expiresAt: T0 })).toThrow(code('fleet.document.expired'));
      expect(() => submit(courier, { type: neverExpires.type })).toThrow(
        code('fleet.document.expiry-not-allowed'),
      );
    });

    it('is reviewed once: verified or rejected with a reason code', () => {
      const submitted = submit(applicant({ marketId }), {});
      const id = submitted.courier.documents[0]!.id;
      const later = T0.add({ hours: 1 });

      const verified = verifyDocument(submitted.courier, id, IN_A_YEAR, later).courier;
      expect(verified.documents[0]).toMatchObject({ status: 'verified', reviewedAt: later });
      expect(() => rejectDocument(verified, id, 'illegible', later)).toThrow(
        code('fleet.document.already-reviewed'),
      );

      const rejected = rejectDocument(submitted.courier, id, 'mismatch', later).courier;
      expect(rejected.documents[0]).toMatchObject({
        status: 'rejected',
        rejectionReason: 'mismatch',
      });
      expect(() => rejectDocument(submitted.courier, id, 'ugly' as never, later)).toThrow(
        code('fleet.document.rejection-reason-unknown'),
      );
      expect(() => verifyDocument(submitted.courier, nextId(), IN_A_YEAR, later)).toThrow(
        code('fleet.document.not-found'),
      );
    });

    it('cannot be verified once it has expired', () => {
      const submitted = submit(applicant({ marketId }), {});
      const id = submitted.courier.documents[0]!.id;

      expect(() => verifyDocument(submitted.courier, id, IN_A_YEAR, IN_A_YEAR)).toThrow(
        code('fleet.document.expired'),
      );
    });

    it('a resubmitted document makes the courier eligible again after expiry', () => {
      const active = activeCourier();
      const vanId = active.vehicles[0]!.id;
      const later = IN_A_YEAR.add({ hours: 1 });
      const renewed = withVerifiedDocuments(
        active,
        rules,
        vanId,
        { expiresAt: IN_A_YEAR.add({ hours: 24 * 365 }) },
        later,
      );

      expect(changeShift(renewed, 'online', rules, later).courier.shift).toBe('online');
    });
  });

  describe('what the operator confirms (security review M1 to M3)', () => {
    const contractorOnly = rules.documents.filter((d) => d.employmentTypes?.includes('contractor'));

    it('approves on the employment type the operator confirms, not the one declared', () => {
      // Declared employee, so the contractor-only documents were never asked for.
      const van = vehicleInput();
      const declared = withVerifiedDocuments(
        addVehicle(applicant({ marketId, employmentType: 'employee' }), van).courier,
        rules,
        van.id,
      );
      expect(contractorOnly.length).toBeGreaterThan(0);
      expect(() =>
        approveCourier(
          declared,
          { employmentType: 'contractor', coldChainCapable: false },
          rules,
          T0,
        ),
      ).toThrow(code('fleet.courier.not-eligible'));

      const approved = approveCourier(
        declared,
        { employmentType: 'employee', coldChainCapable: false },
        rules,
        T0,
      ).courier;
      expect(approved).toMatchObject({ employmentType: 'employee', coldChainCapable: false });
    });

    it('revokes a verified document, after which the courier is neither eligible nor reinstated', () => {
      const active = activeCourier();
      const everyone = rules.documents.find((r) => !r.employmentTypes && !r.coldChainOnly)!;
      const document = active.documents.find((d) => d.type === everyone.type)!;
      const revoked = revokeDocument(active, document.id, 'fraudulent', T0).courier;

      expect(revoked.documents.find((d) => d.id === document.id)).toMatchObject({
        status: 'revoked',
        rejectionReason: 'fraudulent',
      });
      expect(() => changeShift(revoked, 'online', rules, T0)).toThrow(
        code('fleet.courier.not-eligible'),
      );
      const suspended = suspendCourier(revoked, 'documents', T0).courier;
      expect(() => reinstateCourier(suspended, rules, T0)).toThrow(
        code('fleet.courier.not-eligible'),
      );
      expect(() => revokeDocument(revoked, document.id, 'fraudulent', T0)).toThrow(
        code('fleet.document.not-verified'),
      );
    });

    it('takes the expiry the operator read on the document, not the declared one', () => {
      const ofCourier = rules.documents.find((d) => !d.perVehicle && d.expires)!;
      const neverExpires = rules.documents.find((d) => !d.perVehicle && !d.expires)!;
      const id = nextId<'CourierDocument'>();
      const courier = applicant({ marketId });
      const submitted = submitDocument(
        courier,
        {
          id,
          type: ofCourier.type,
          fileKey: `fleet/${marketId}/${courier.id}/${id}`,
          mediaType: 'application/pdf',
          expiresAt: T0.add({ hours: 24 * 365 * 70 }),
        },
        rules,
        T0,
      ).courier;
      const confirmed = T0.add({ hours: 24 * 30 });

      expect(() => verifyDocument(submitted, id, undefined, T0)).toThrow(
        code('fleet.document.expiry-required'),
      );
      expect(verifyDocument(submitted, id, confirmed, T0).courier.documents[0]!.expiresAt).toEqual(
        confirmed,
      );

      const otherId = nextId<'CourierDocument'>();
      const noExpiry = submitDocument(
        courier,
        {
          id: otherId,
          type: neverExpires.type,
          fileKey: `fleet/${marketId}/${courier.id}/${otherId}`,
          mediaType: 'application/pdf',
        },
        rules,
        T0,
      ).courier;
      expect(() => verifyDocument(noExpiry, otherId, confirmed, T0)).toThrow(
        code('fleet.document.expiry-not-allowed'),
      );
    });
  });
});
