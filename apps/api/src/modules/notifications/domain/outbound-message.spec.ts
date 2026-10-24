import { Temporal } from '@mondapac-drive/shared-kernel';
import { notificationSettings } from '../../../../test/support/notifications-markets';
import { TEST_MARKET_IDS } from '../../../../test/support/test-config';
import {
  CLAIM_LEASE_SECONDS,
  claim,
  exhaust,
  isExhausted,
  isDue,
  newOutboundMessage,
  recordAttempt,
  resend,
  retryDelaySeconds,
  type OutboundMessage,
} from './outbound-message';
import { smsRetryPolicy } from './sms';

const now = Temporal.Instant.from('2026-11-02T00:00:00Z');
const failed = { sent: false, errorCode: 'http.503', retryable: true } as const;

describe.each(TEST_MARKET_IDS)('webhook retry rules in %s', (marketId) => {
  const policy = notificationSettings.get(marketId).webhookRetry;

  it('doubles the wait after each failure, from the first retry up to the cap', () => {
    expect(retryDelaySeconds(policy, 1)).toBe(policy.firstRetrySeconds);
    expect(retryDelaySeconds(policy, 2)).toBe(
      Math.min(policy.firstRetrySeconds * 2, policy.maxRetrySeconds),
    );
    expect(retryDelaySeconds(policy, 30)).toBe(policy.maxRetrySeconds);
  });

  it('retries a failed attempt after the wait, then dead-letters it after the last attempt', () => {
    let message: OutboundMessage = newOutboundMessage(now);
    let at = now;
    for (let attempt = 1; attempt < policy.maxAttempts; attempt += 1) {
      message = recordAttempt(claim(message, at), failed, at, policy);
      expect(message).toMatchObject({ status: 'pending', attempts: attempt });
      expect(message.nextAttemptAt).toEqual(
        at.add({ seconds: retryDelaySeconds(policy, attempt) }),
      );
      expect(isDue(message, at)).toBe(false);
      at = message.nextAttemptAt!;
      expect(isDue(message, at)).toBe(true);
    }
    message = recordAttempt(claim(message, at), failed, at, policy);
    expect(message).toMatchObject({
      status: 'dead',
      attempts: policy.maxAttempts,
      nextAttemptAt: null,
      lastErrorCode: 'http.503',
      deadAt: at,
    });
  });

  it('dead-letters at once when the failure cannot succeed on a retry', () => {
    const message = recordAttempt(
      claim(newOutboundMessage(now), now),
      { sent: false, errorCode: 'webhook-url.private-host', retryable: false },
      now,
      policy,
    );
    expect(message.status).toBe('dead');
    expect(message.attempts).toBe(1);
  });

  it('marks a successful attempt sent and never due again', () => {
    const message = recordAttempt(claim(newOutboundMessage(now), now), { sent: true }, now, policy);
    expect(message).toMatchObject({ status: 'sent', sentAt: now, nextAttemptAt: null });
    expect(isDue(message, now.add({ hours: 1 }))).toBe(false);
  });

  it('hides a claimed message for the lease and counts the claim as an attempt', () => {
    const claimed = claim(newOutboundMessage(now), now);
    expect(claimed.attempts).toBe(1);
    expect(isDue(claimed, now.add({ seconds: CLAIM_LEASE_SECONDS - 1 }))).toBe(false);
    expect(isDue(claimed, now.add({ seconds: CLAIM_LEASE_SECONDS }))).toBe(true);
    expect(() => claim(claimed, now)).toThrow(/not due/);
  });

  it('lets an operator send a dead message again, with a fresh count, but nothing else', () => {
    const dead = recordAttempt(
      claim(newOutboundMessage(now), now),
      { sent: false, errorCode: 'x', retryable: false },
      now,
      policy,
    );
    const later = now.add({ hours: 2 });
    expect(resend(dead, later)).toMatchObject({
      status: 'pending',
      attempts: 0,
      nextAttemptAt: later,
      deadAt: null,
    });
    expect(() => resend(newOutboundMessage(now), later)).toThrow(/dead-lettered/);
  });

  it('dead-letters a message whose last claim was never recorded, instead of claiming it again', () => {
    let message: OutboundMessage = newOutboundMessage(now);
    let at = now;
    for (let attempt = 1; attempt <= policy.maxAttempts; attempt += 1) {
      expect(isExhausted(message, policy)).toBe(false);
      message = claim(message, at);
      at = message.nextAttemptAt!;
    }
    expect(isExhausted(message, policy)).toBe(true);
    expect(exhaust(message, at)).toMatchObject({
      status: 'dead',
      deadAt: at,
      lastErrorCode: 'notifications.attempts-exhausted',
    });
  });

  it('takes the SMS attempts from the Market file', () => {
    expect(smsRetryPolicy(notificationSettings.get(marketId).sms).maxAttempts).toBe(
      notificationSettings.get(marketId).sms.maxAttempts,
    );
  });
});

describe('retry rules across Markets', () => {
  it('differ between AU and ZZ, so a rule that only holds for one Market is caught', () => {
    const [au, zz] = TEST_MARKET_IDS.map((id) => notificationSettings.get(id).webhookRetry);
    expect(au).not.toEqual(zz);
  });

  it('refuses a failure count below one', () => {
    const policy = { maxAttempts: 3, firstRetrySeconds: 10, maxRetrySeconds: 60 };
    expect(() => retryDelaySeconds(policy, 0)).toThrow(RangeError);
  });

  it('refuses to record an attempt that was not claimed', () => {
    const policy = { maxAttempts: 3, firstRetrySeconds: 10, maxRetrySeconds: 60 };
    expect(() => recordAttempt(newOutboundMessage(now), { sent: true }, now, policy)).toThrow(
      /not claimed/,
    );
  });
});
