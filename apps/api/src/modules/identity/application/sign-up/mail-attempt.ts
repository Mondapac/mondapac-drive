import { ok } from '@mondapac-drive/shared-kernel';
import type { CallContext, Population, Temporal } from '@mondapac-drive/shared-kernel';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { reservationVerdict } from '../../domain/throttle';
import type { IdentityMarketPolicy } from '../ports/identity-market-policy';
import type { ThrottleKeys } from '../ports/session-secrets';
import type { ThrottleCounter, ThrottleRepository } from '../ports/throttle.repository';

export interface MailAttemptDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly throttles: ThrottleRepository;
  readonly keys: ThrottleKeys;
  readonly policy: IdentityMarketPolicy;
}

/**
 * Counts one mail-causing request on `mail.account` (the address, per population) and
 * `mail.origin`, in a short READ COMMITTED unit of its own (identity design 6.7, 6.8; Hassan L4),
 * and answers whether a mail may go: the verdict of the reservations that unit returned, carried
 * into the caller's later unit (Mojtaba, item 3). The request itself is never refused by it.
 * Throws when the counters are unreachable; the caller decides how that fails.
 */
export async function countMailAttempt(
  deps: MailAttemptDependencies,
  context: CallContext,
  population: Population,
  emailNormalized: string,
  origin: string,
  now: Temporal.Instant,
): Promise<boolean> {
  const { market } = context;
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
  const counted = await deps.unitOfWork.run(market, async () => {
    const reservations = await deps.throttles.reserve(market, counters, now);
    const reserved = reservations.map((reservation, index) => ({
      reservation,
      rule: counters[index]!.rule,
    }));
    return ok(reservationVerdict(reserved, now).allowed);
  });
  return counted.ok && counted.value;
}
