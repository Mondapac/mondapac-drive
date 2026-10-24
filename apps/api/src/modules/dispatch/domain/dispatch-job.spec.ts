import { Temporal, uuidV7, type Id, type MarketId } from '@mondapac-drive/shared-kernel';
import {
  AU,
  courierId,
  dispatchSettings,
  requirements,
  ZZ,
} from '../../../../test/support/dispatch-markets';
import {
  answerOffer,
  assignManually,
  cancelJob,
  openDispatchJob,
  pendingOffers,
  redispatch,
  sendWave,
  sweep,
  type DispatchJob,
} from './dispatch-job';
import { DispatchDomainError } from './errors';
import type { RankedCandidate } from './matching';

const now = Temporal.Instant.from('2026-11-02T08:00:00Z');
const deliveryId = '0190a000-0000-7000-8000-0000000000d1' as Id<'Delivery'>;
const jobId = '0190a000-0000-7000-8000-0000000000a1' as Id<'DispatchJob'>;

let offerCounter = 0;
const nextOfferId = (): Id<'DispatchOffer'> => {
  offerCounter += 1;
  const bytes = new Uint8Array(10);
  bytes[9] = offerCounter;
  bytes[8] = 0xff;
  return uuidV7(1_800_000_000_000, bytes) as Id<'DispatchOffer'>;
};

const candidates = (...ns: number[]): RankedCandidate[] =>
  ns.map((n) => ({ courierId: courierId(n), vehicle: 'car', distanceMetres: 100 * n }));

/** The code of the domain rule `act` breaks, or undefined when it breaks none. */
function codeOf(act: () => unknown): string | undefined {
  try {
    act();
  } catch (error) {
    if (error instanceof DispatchDomainError) return error.code;
    throw error;
  }
  return undefined;
}

const types = (events: readonly { readonly type: string }[]) => events.map((e) => e.type);

describe.each([
  ['AU', AU],
  ['ZZ', ZZ],
])('a dispatch job in %s', (_name, market: MarketId) => {
  const settings = dispatchSettings.get(market);
  const timeout = { seconds: settings.offerTimeoutSeconds };

  function open(windowStart?: Temporal.Instant): DispatchJob {
    return openDispatchJob(
      {
        id: jobId,
        marketId: market,
        deliveryId,
        requirements: requirements(),
        ...(windowStart === undefined ? {} : { windowStart }),
      },
      now,
      settings,
    );
  }

  /** An on-demand job with its first wave out to the given couriers. */
  function offered(...ns: number[]): DispatchJob {
    const swept = sweep(open(), now, settings);
    expect(swept.waveDue).toBe(true);
    return sendWave(swept.job, candidates(...ns), now, settings, nextOfferId).job;
  }

  describe('opening', () => {
    it('offers an on-demand delivery at once', () => {
      const job = open();

      expect(job).toMatchObject({ status: 'OFFERING', opensAt: now, nextActionAt: now, round: 0 });
      expect(sweep(job, now, settings)).toMatchObject({ waveDue: true, changed: false });
    });

    it("opens a scheduled delivery the Market's lead time before its window", () => {
      const windowStart = now.add({ hours: 3 });
      const opensAt = windowStart.subtract({ minutes: settings.scheduledLeadMinutes });
      const job = open(windowStart);

      expect(job).toMatchObject({ status: 'WAITING', opensAt });
      expect(sweep(job, opensAt.subtract({ seconds: 1 }), settings).changed).toBe(false);

      const swept = sweep(job, opensAt, settings);
      expect(swept).toMatchObject({ opened: true, waveDue: true, changed: true });
      expect(swept.job.status).toBe('OFFERING');
    });

    it('opens at once when the window starts within the lead time', () => {
      const job = open(now.add({ minutes: settings.scheduledLeadMinutes - 1 }));

      expect(job.status).toBe('OFFERING');
    });
  });

  describe('waves and the accept timeout', () => {
    it(`sends ${settings.waveSize} offer(s) per wave, each expiring after the Market's timeout`, () => {
      const swept = sweep(open(), now, settings);
      const wave = sendWave(swept.job, candidates(1, 2, 3), now, settings, nextOfferId);

      const pending = pendingOffers(wave.job);
      expect(pending.map((o) => o.courierId)).toEqual(
        [1, 2, 3].slice(0, settings.waveSize).map(courierId),
      );
      expect(pending.every((o) => o.expiresAt.equals(now.add(timeout)))).toBe(true);
      expect(wave.job).toMatchObject({ round: 1, nextActionAt: now.add(timeout) });
      expect(types(wave.events)).toEqual(
        Array.from({ length: settings.waveSize }, () => 'dispatch.offer-sent.v1'),
      );
      expect(wave.events.every((e) => e.aggregateVersion === 1)).toBe(true);
    });

    it('keeps the offers open until the timeout, then expires them and asks for the next wave', () => {
      const job = offered(1, 2, 3);
      const almost = now.add(timeout).subtract({ milliseconds: 1 });

      expect(sweep(job, almost, settings)).toMatchObject({ changed: false, waveDue: false });

      const swept = sweep(job, now.add(timeout), settings);
      expect(swept.waveDue).toBe(true);
      expect(pendingOffers(swept.job)).toEqual([]);
      expect(types(swept.events)).toEqual(
        Array.from({ length: settings.waveSize }, () => 'dispatch.offer-expired.v1'),
      );
      expect(swept.events.every((e) => e.aggregateVersion === 2)).toBe(true);
    });

    it('offers couriers not asked yet before asking again those whose offer expired', () => {
      const first = offered(1, 2, 3, 4, 5);
      const later = now.add(timeout);
      const swept = sweep(first, later, settings);
      const second = sendWave(swept.job, candidates(1, 2, 3, 4, 5), later, settings, nextOfferId);

      const fresh = [1, 2, 3, 4, 5].slice(settings.waveSize, settings.waveSize * 2);
      expect(pendingOffers(second.job).map((o) => o.courierId)).toEqual(fresh.map(courierId));

      const onlyAskedBefore = sendWave(swept.job, candidates(1), later, settings, nextOfferId);
      expect(pendingOffers(onlyAskedBefore.job).map((o) => o.courierId)).toEqual([courierId(1)]);
    });

    it('counts a round with no candidate and tries again after one timeout', () => {
      const swept = sweep(open(), now, settings);
      const empty = sendWave(swept.job, [], now, settings, nextOfferId);

      expect(empty.events).toEqual([]);
      expect(empty.job).toMatchObject({ round: 1, nextActionAt: now.add(timeout) });
      expect(sweep(empty.job, now.add(timeout), settings).waveDue).toBe(true);
    });

    it(`is exhausted after ${settings.maxRounds} unanswered rounds, for a dispatcher`, () => {
      let job = open();
      let at = now;
      for (let round = 1; round <= settings.maxRounds; round += 1) {
        const swept = sweep(job, at, settings);
        expect(swept.waveDue).toBe(true);
        job = sendWave(swept.job, candidates(round), at, settings, nextOfferId).job;
        at = at.add(timeout);
      }

      const last = sweep(job, at, settings);
      expect(last.job.status).toBe('EXHAUSTED');
      expect(last.job.nextActionAt).toBeUndefined();
      expect(types(last.events)).toEqual([
        'dispatch.offer-expired.v1',
        'dispatch.job-exhausted.v1',
      ]);
      expect(last.events[1]).toMatchObject({
        aggregateId: jobId,
        aggregateVersion: last.job.version,
        payload: { deliveryId, rounds: settings.maxRounds },
      });
      expect(codeOf(() => sendWave(last.job, candidates(9), at, settings, nextOfferId))).toBe(
        'dispatch.not-offering',
      );
    });
  });

  describe('answers', () => {
    it('assigns the delivery to the courier who accepts and withdraws the other offers', () => {
      const job = offered(1, 2);
      const change = answerOffer(job, courierId(1), 'accept', now.add({ seconds: 5 }));

      expect(change.job).toMatchObject({
        status: 'ASSIGNED',
        assignment: { courierId: courierId(1), vehicle: 'car', method: 'offer' },
      });
      expect(change.job.nextActionAt).toBeUndefined();
      expect(pendingOffers(change.job)).toEqual([]);
      expect(types(change.events)).toEqual([
        'dispatch.offer-accepted.v1',
        ...(settings.waveSize > 1 ? ['dispatch.offer-withdrawn.v1'] : []),
        'dispatch.courier-assigned.v1',
      ]);
      expect(change.events.at(-1)).toMatchObject({
        aggregateVersion: change.job.version,
        payload: { courierId: courierId(1), method: 'offer', previousCourierId: null },
      });
    });

    it('refuses an answer once the offer expired, and from a courier without an offer', () => {
      const job = offered(1, 2);

      expect(codeOf(() => answerOffer(job, courierId(1), 'accept', now.add(timeout)))).toBe(
        'offer.expired',
      );
      expect(codeOf(() => answerOffer(job, courierId(9), 'accept', now))).toBe('offer.not-pending');
    });

    it('moves on at once when the last offer of a wave is declined, and never asks that courier again', () => {
      const job = offered(1, 2);
      let declined = job;
      for (const offer of pendingOffers(job)) {
        declined = answerOffer(declined, offer.courierId, 'decline', now.add({ seconds: 1 })).job;
      }

      const swept = sweep(declined, now.add({ seconds: 1 }), settings);
      expect(swept.waveDue).toBe(true);
      const next = sendWave(swept.job, candidates(1, 2), now, settings, nextOfferId);
      const askedAgain = pendingOffers(next.job).map((o) => o.courierId);
      expect(askedAgain).toEqual(settings.waveSize > 1 ? [] : [courierId(2)]);
    });
  });

  describe('dispatcher actions', () => {
    it('assigns by hand after the job was exhausted, and reassigns to another courier', () => {
      const exhausted: DispatchJob = { ...open(), status: 'EXHAUSTED', round: settings.maxRounds };
      const assigned = assignManually(exhausted, courierId(7), 'van', now);

      expect(assigned.job).toMatchObject({
        status: 'ASSIGNED',
        assignment: { courierId: courierId(7), vehicle: 'van', method: 'manual' },
      });

      const reassigned = assignManually(assigned.job, courierId(8), 'car', now);
      expect(reassigned.events.at(-1)).toMatchObject({
        type: 'dispatch.courier-assigned.v1',
        payload: { courierId: courierId(8), method: 'manual', previousCourierId: courierId(7) },
      });
      expect(codeOf(() => assignManually(reassigned.job, courierId(8), 'car', now))).toBe(
        'dispatch.already-assigned',
      );
    });

    it('withdraws the offers out when a dispatcher assigns during offering', () => {
      const change = assignManually(offered(1, 2), courierId(7), 'car', now);

      expect(types(change.events)).toEqual([
        ...Array.from({ length: settings.waveSize }, () => 'dispatch.offer-withdrawn.v1'),
        'dispatch.courier-assigned.v1',
      ]);
    });

    it('dispatches again without the courier who dropped the delivery', () => {
      const assigned = answerOffer(offered(1, 2), courierId(1), 'accept', now).job;
      const again = redispatch(assigned, now);

      expect(again.job).toMatchObject({ status: 'OFFERING', round: 0, nextActionAt: now });
      expect(again.job.assignment).toBeUndefined();
      const wave = sendWave(again.job, candidates(1, 3, 4), now, settings, nextOfferId);
      expect(pendingOffers(wave.job).map((o) => o.courierId)).not.toContain(courierId(1));
    });

    it('stops when the delivery is cancelled, and refuses assignment afterwards', () => {
      const cancelled = cancelJob(offered(1, 2), now);

      expect(cancelled.job.status).toBe('CANCELLED');
      expect(pendingOffers(cancelled.job)).toEqual([]);
      expect(sweep(cancelled.job, now.add({ hours: 1 }), settings).changed).toBe(false);
      expect(codeOf(() => assignManually(cancelled.job, courierId(1), 'car', now))).toBe(
        'dispatch.cancelled',
      );
    });
  });
});
