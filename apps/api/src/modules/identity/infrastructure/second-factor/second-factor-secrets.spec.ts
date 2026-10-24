import { createHmac } from 'node:crypto';
import { err, ok, parseId, Temporal } from '@mondapac-drive/shared-kernel';
import type { Id, MarketContext } from '@mondapac-drive/shared-kernel';
import { testMarketContext } from '@mondapac-drive/shared-kernel/testing';
import { TEST_MARKETS } from '../../../../../test/support/test-config';
import { PLATFORM_TENANT_ID } from '../../../../platform/market-context/tenant';
import type { SubjectKeyService } from '../../../../platform/subject-keys/subject-key-service';
import { SecondFactorKeyUnavailableError } from '../../application/ports/second-factor-secrets';
import { parseRecoveryCode, RECOVERY_CODES } from '../../domain/recovery-code';
import { candidateSteps, timeStepAt } from '../../domain/totp';
import {
  RECOVERY_CODE_HASH,
  SECOND_FACTOR_SECRET,
  SubjectKeySecondFactorSecrets,
} from './subject-key-second-factor-secrets';
import { hotp, matchingStep } from './totp';

// The RFC 4226 appendix D and RFC 6238 appendix B secret: ASCII "12345678901234567890".
const RFC_SECRET = new Uint8Array(Buffer.from('12345678901234567890', 'ascii'));

describe('HOTP and TOTP on node:crypto (identity design 7.1; spike 2)', () => {
  it.each([
    [0, '755224'],
    [1, '287082'],
    [2, '359152'],
    [3, '969429'],
    [4, '338314'],
    [5, '254676'],
    [6, '287922'],
    [7, '162583'],
    [8, '399871'],
    [9, '520489'],
  ])('RFC 4226 HOTP vector, counter %i is %s', (counter, code) => {
    expect(hotp(RFC_SECRET, counter)).toBe(code);
  });

  it.each([
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
    [20000000000, '65353130'],
  ])('RFC 6238 SHA-1 vector at %i s is %s (eight digits; six are its last six)', (t, code) => {
    const step = timeStepAt(Temporal.Instant.fromEpochMilliseconds(t * 1000));
    expect(hotp(RFC_SECRET, step, 8)).toBe(code);
    expect(hotp(RFC_SECRET, step)).toBe(code.slice(2));
  });

  it('refuses a negative counter and an unsupported length', () => {
    expect(() => hotp(RFC_SECRET, -1)).toThrow(RangeError);
    expect(() => hotp(RFC_SECRET, 1, 5)).toThrow(RangeError);
  });

  it('finds the step a code belongs to among the candidates, or none', () => {
    const at = Temporal.Instant.fromEpochMilliseconds(1111111111 * 1000);
    const steps = candidateSteps(at);
    const current = timeStepAt(at);
    expect(matchingStep(RFC_SECRET, hotp(RFC_SECRET, current), steps)).toBe(current);
    expect(matchingStep(RFC_SECRET, hotp(RFC_SECRET, current - 1), steps)).toBe(current - 1);
    expect(matchingStep(RFC_SECRET, hotp(RFC_SECRET, current + 1), steps)).toBe(current + 1);
    expect(matchingStep(RFC_SECRET, hotp(RFC_SECRET, current + 2), steps)).toBeNull();
    expect(matchingStep(RFC_SECRET, hotp(RFC_SECRET, current - 2), steps)).toBeNull();
    expect(matchingStep(RFC_SECRET, '12345', steps)).toBeNull();
  });
});

/**
 * A stand-in with the port's contract and none of its cryptography: "ciphertext" names the
 * Market, the subject and the field, so a value bound to another one does not open; a
 * destroyed subject answers `subject-key.destroyed`.
 */
class LabelledKeys implements SubjectKeyService {
  readonly destroyed = new Set<string>();
  readonly calls: string[] = [];

  createKey(): Promise<void> {
    return Promise.resolve();
  }
  encrypt(market: MarketContext, subject: Id, field: string, plain: string) {
    this.calls.push(`encrypt:${field}`);
    if (this.destroyed.has(subject)) return Promise.resolve(err(DESTROYED));
    return Promise.resolve(ok(`${market.marketId}|${subject}|${field}|${plain}`));
  }
  decrypt(market: MarketContext, subject: Id, field: string, cipher: string) {
    this.calls.push(`decrypt:${field}`);
    if (this.destroyed.has(subject)) return Promise.resolve(err(DESTROYED));
    const [m, s, f, plain] = cipher.split('|');
    if (m !== market.marketId || s !== subject || f !== field || plain === undefined) {
      throw new Error('integrity');
    }
    return Promise.resolve(ok(plain));
  }
  hmac(market: MarketContext, subject: Id, purpose: string, data: Uint8Array) {
    this.calls.push(`hmac:${purpose}`);
    if (this.destroyed.has(subject)) return Promise.resolve(err(DESTROYED));
    const key = `${market.marketId}|${subject}|${purpose}`;
    return Promise.resolve(ok(createHmac('sha256', key).update(data).digest('hex')));
  }
  destroyKey(_market: MarketContext, subject: Id): Promise<void> {
    this.destroyed.add(subject);
    return Promise.resolve();
  }
}
const DESTROYED = { code: 'subject-key.destroyed' } as const;

function id<T extends string>(text: string): Id<T> {
  const parsed = parseId(text);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
}
const ACCOUNT = id<'Account'>('01990000-0000-7000-8000-000000000001');
const OTHER_ACCOUNT = id<'Account'>('01990000-0000-7000-8000-000000000002');

describe.each(TEST_MARKETS)('SubjectKeySecondFactorSecrets in market %s (7.3, 7.5, H2)', (code) => {
  const market = testMarketContext(code, PLATFORM_TENANT_ID);
  const now = Temporal.Instant.from('2026-10-08T10:00:00Z');
  const setUp = () => {
    const keys = new LabelledKeys();
    return { keys, secrets: new SubjectKeySecondFactorSecrets(keys) };
  };

  it('makes a new 160-bit secret each time', () => {
    const { secrets } = setUp();
    const a = secrets.newSecret();
    const b = secrets.newSecret();
    expect(a).toHaveLength(20);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
  });

  it("seals the secret under the account's key with its own label, and checks a code with it", async () => {
    const { keys, secrets } = setUp();
    const secret = secrets.newSecret();
    const sealed = await secrets.seal(market, ACCOUNT, secret);
    expect(sealed).not.toContain(Buffer.from(secret).toString('hex'));
    expect(keys.calls).toEqual([`encrypt:${SECOND_FACTOR_SECRET}`]);

    const steps = candidateSteps(now);
    const step = timeStepAt(now);
    const code = hotp(secret, step);
    await expect(secrets.matchStored(market, ACCOUNT, sealed, code, steps)).resolves.toBe(step);
    await expect(
      secrets.matchStored(market, ACCOUNT, sealed, hotp(secret, step + 5), steps),
    ).resolves.toBeNull();
    expect(secrets.matchPlain(secret, code, steps)).toBe(step);
    expect(secrets.matchPlain(secret.subarray(1), code, steps)).toBeNull();
  });

  it('matches nothing once the key is destroyed (erasure): it throws, and refuses to seal', async () => {
    const { keys, secrets } = setUp();
    const secret = secrets.newSecret();
    const sealed = await secrets.seal(market, ACCOUNT, secret);
    await keys.destroyKey(market, ACCOUNT);
    const step = timeStepAt(now);
    // Slice 7b (Hassan I-3): a destroyed key is never a quiet "no match"; the caller alarms.
    await expect(
      secrets.matchStored(market, ACCOUNT, sealed, hotp(secret, step), [step]),
    ).rejects.toBeInstanceOf(SecondFactorKeyUnavailableError);
    await expect(secrets.seal(market, ACCOUNT, secret)).rejects.toBeInstanceOf(
      SecondFactorKeyUnavailableError,
    );
    await expect(
      secrets.recoveryCodeHash(market, ACCOUNT, parseRecoveryCode('ABCDEFGHJK')!),
    ).rejects.toBeInstanceOf(SecondFactorKeyUnavailableError);
  });

  it('refuses to seal a secret that is not 20 bytes', async () => {
    const { secrets } = setUp();
    await expect(secrets.seal(market, ACCOUNT, new Uint8Array(16))).rejects.toThrow(RangeError);
  });

  it('makes ten distinct canonical recovery codes', () => {
    const { secrets } = setUp();
    const codes = secrets.newRecoveryCodes();
    expect(codes).toHaveLength(RECOVERY_CODES.count);
    expect(new Set(codes).size).toBe(RECOVERY_CODES.count);
    for (const c of codes) expect(parseRecoveryCode(c)).toBe(c);
  });

  it('hashes a recovery code per account under its own purpose, 32 bytes (H2)', async () => {
    const { keys, secrets } = setUp();
    const code = parseRecoveryCode('abcde-fghjk')!;
    const mine = await secrets.recoveryCodeHash(market, ACCOUNT, code);
    const again = await secrets.recoveryCodeHash(market, ACCOUNT, parseRecoveryCode('ABCDEFGHJK')!);
    const theirs = await secrets.recoveryCodeHash(market, OTHER_ACCOUNT, code);
    expect(mine).toHaveLength(32);
    expect(Buffer.from(mine).equals(Buffer.from(again))).toBe(true);
    expect(Buffer.from(mine).equals(Buffer.from(theirs))).toBe(false);
    expect(keys.calls.every((call) => call === `hmac:${RECOVERY_CODE_HASH}`)).toBe(true);
  });
});
