import type { MarketContext, Temporal } from '@mondapac-drive/shared-kernel';
import { reservationVerdict, type ThrottleVerdict } from '../../domain/throttle';
import type { IdentityMarketPolicy } from '../ports/identity-market-policy';
import type { ThrottleKeys } from '../ports/session-secrets';
import type { ThrottleCounter, ThrottleRepository } from '../ports/throttle.repository';

export interface InvitationMailBudgetDependencies {
  readonly throttles: ThrottleRepository;
  readonly keys: ThrottleKeys;
  readonly policy: IdentityMarketPolicy;
}

/**
 * Counts one invitation mail on `mail.account` (the invited address, in the population the
 * invitation opens an account in) and `mail.origin` (the admin's client), as identity design 6.8
 * lists "invitation mail" (Hassan M1 on PR #204; the admin re-send too since the phase 2
 * follow-ups). Runs in the caller's open unit, the one that issues or re-issues the invitation: a
 * refused request answers `err`, which commits nothing, so a counter at its limit stays at it and
 * keeps refusing until its window or block ends; a counted request commits with the invitation.
 */
export async function reserveInvitationMail(
  deps: InvitationMailBudgetDependencies,
  market: MarketContext,
  population: 'admin' | 'courier',
  emailNormalized: string,
  origin: string,
  now: Temporal.Instant,
): Promise<ThrottleVerdict> {
  const rules = deps.policy.mailThrottles(market);
  const accountKey = deps.keys.account(market, population, emailNormalized);
  const counters: readonly ThrottleCounter[] = [
    { kind: 'mail.account', keyHash: accountKey, accountKey, rule: rules.account },
    {
      kind: 'mail.origin',
      keyHash: deps.keys.origin(market, origin),
      accountKey: null,
      rule: rules.origin,
    },
  ];
  const reservations = await deps.throttles.reserve(market, counters, now);
  return reservationVerdict(
    reservations.map((reservation, index) => ({ reservation, rule: counters[index]!.rule })),
    now,
  );
}
