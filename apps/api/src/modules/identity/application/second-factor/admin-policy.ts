import type { MarketContext } from '@mondapac-drive/shared-kernel';
import type { IdentityMarketPolicy } from '../ports/identity-market-policy';
import type { ChallengeStepPolicy } from './challenge-code-step';

/**
 * The policy values every second-factor step reads before any unit (identity design 2.1, 6.8):
 * the challenge policy, the `second-factor.account` counter and the `sign-in.origin` counter. Null
 * while the Market configures no challenge policy or second-factor counter: the step fails closed
 * (`access.unavailable`), never with a default (the 7b keys of the Market-config PR).
 */
export function secondFactorStepPolicy(
  policy: IdentityMarketPolicy,
  market: MarketContext,
): ChallengeStepPolicy | null {
  const challenge = policy.challengePolicy(market);
  const secondFactorThrottle = policy.secondFactorThrottle(market);
  if (challenge === null || secondFactorThrottle === null) return null;
  return { challenge, secondFactorThrottle, signInOrigin: policy.signInThrottles(market).origin };
}
