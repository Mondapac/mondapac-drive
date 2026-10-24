import { Temporal } from '@mondapac-drive/shared-kernel';
import {
  blockAfterFailure,
  reservationVerdict,
  windowRestartBefore,
  type ThrottleReservation,
  type ThrottleRule,
} from './throttle';

const NOW = Temporal.Instant.from('2026-10-08T10:00:00Z');
const KEY = new Uint8Array(32);

function reservation(fields: Partial<ThrottleReservation>): ThrottleReservation {
  return {
    kind: 'sign-in.account-origin',
    keyHash: KEY,
    attempts: 1,
    windowStartedAt: NOW,
    blockedUntil: null,
    ...fields,
  };
}

// The two Market fixtures carry different numbers (config/markets/AU.json, ZZ.json).
describe.each<[string, ThrottleRule]>([
  ['AU', { limit: 5, windowMinutes: 15, blockMinutes: 15 }],
  ['ZZ', { limit: 4, windowMinutes: 10, blockMinutes: 20 }],
])('throttle counters in %s (identity design 6.8; data design 3.5)', (_code, rule) => {
  it('allows every attempt up to the limit, the reserved one included', () => {
    for (let attempts = 1; attempts <= rule.limit; attempts += 1) {
      expect(reservationVerdict([{ reservation: reservation({ attempts }), rule }], NOW)).toEqual({
        allowed: true,
      });
    }
  });

  it('refuses a reservation above the limit, announcing the block', () => {
    const verdict = reservationVerdict(
      [{ reservation: reservation({ attempts: rule.limit + 1 }), rule }],
      NOW,
    );

    expect(verdict).toEqual({ allowed: false, retryAfterSeconds: rule.blockMinutes * 60 });
  });

  it('refuses while blocked, with the time left of the block', () => {
    const blockedUntil = NOW.add({ seconds: 90 });

    expect(
      reservationVerdict([{ reservation: reservation({ attempts: 1, blockedUntil }), rule }], NOW),
    ).toEqual({ allowed: false, retryAfterSeconds: 90 });
  });

  it('ignores a block that has ended', () => {
    const blockedUntil = NOW.subtract({ seconds: 1 });

    expect(reservationVerdict([{ reservation: reservation({ blockedUntil }), rule }], NOW)).toEqual(
      { allowed: true },
    );
  });

  it('answers the longest wait when several counters refuse', () => {
    const verdict = reservationVerdict(
      [
        { reservation: reservation({ blockedUntil: NOW.add({ seconds: 30 }) }), rule },
        {
          reservation: reservation({
            kind: 'sign-in.origin',
            blockedUntil: NOW.add({ seconds: 700 }),
          }),
          rule,
        },
      ],
      NOW,
    );

    expect(verdict).toEqual({ allowed: false, retryAfterSeconds: 700 });
  });

  it('blocks on the failure that reaches the limit, never before', () => {
    expect(blockAfterFailure(reservation({ attempts: rule.limit - 1 }), rule, NOW)).toBeNull();
    expect(blockAfterFailure(reservation({ attempts: rule.limit }), rule, NOW)).toEqual(
      NOW.add({ minutes: rule.blockMinutes }),
    );
  });

  it('restarts a window that started a whole window ago or earlier', () => {
    expect(windowRestartBefore(rule, NOW)).toEqual(NOW.subtract({ minutes: rule.windowMinutes }));
  });
});

describe('a counter without a block (mail counters)', () => {
  const rule: ThrottleRule = { limit: 3, windowMinutes: 60, blockMinutes: 0 };

  it('never blocks; above the limit it refuses until the window ends', () => {
    const windowStartedAt = NOW.subtract({ minutes: 45 });

    expect(blockAfterFailure(reservation({ attempts: 3 }), rule, NOW)).toBeNull();
    expect(
      reservationVerdict(
        [{ reservation: reservation({ attempts: 4, windowStartedAt }), rule }],
        NOW,
      ),
    ).toEqual({ allowed: false, retryAfterSeconds: 15 * 60 });
  });
});
