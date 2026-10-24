import {
  localRateLimitSecret,
  LocalRateLimitSecretRefusedError,
  RateLimitOriginKeys,
} from './origin-keys';

describe('rate-limit origin keys (identity data design HF3)', () => {
  const secret = localRateLimitSecret({ nodeEnv: 'test', nodeEnvExplicit: true });

  it('answers 64 lowercase hex, the same for the same origin on every instance', () => {
    const key = new RateLimitOriginKeys(secret).keyOf('203.0.113.7');

    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(new RateLimitOriginKeys(secret).keyOf('203.0.113.7')).toBe(key);
    expect(new RateLimitOriginKeys(secret).keyOf('203.0.113.8')).not.toBe(key);
  });

  it('depends on the secret', () => {
    const other = new Uint8Array(32).fill(7);

    expect(new RateLimitOriginKeys(other).keyOf('203.0.113.7')).not.toBe(
      new RateLimitOriginKeys(secret).keyOf('203.0.113.7'),
    );
  });

  it('refuses a secret of the wrong size and an empty origin', () => {
    expect(() => new RateLimitOriginKeys(new Uint8Array(16))).toThrow(TypeError);
    expect(() => new RateLimitOriginKeys(secret).keyOf('')).toThrow(TypeError);
  });

  it.each([
    { nodeEnv: 'production', nodeEnvExplicit: true },
    { nodeEnv: 'development', nodeEnvExplicit: false },
  ] as const)('refuses the stand-in secret for %o', (environment) => {
    expect(() => localRateLimitSecret(environment)).toThrow(LocalRateLimitSecretRefusedError);
  });
});
