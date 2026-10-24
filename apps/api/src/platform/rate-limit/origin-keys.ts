import { createHash, createHmac, hkdfSync } from 'node:crypto';
import { Logger } from '@nestjs/common';
import type { AppConfig } from '../config/app-config';

const SECRET_BYTES = 32;

/** The HKDF info of the origin key: distinct from every module's rate-counter label. */
const ORIGIN_KEY_INFO = 'platform.rate-limit.origin';

/**
 * The counter key of an origin (identity data design HF3, as the module rate counters): the
 * lowercase hex of HMAC-SHA-256 under a key derived with HKDF-SHA-256 from the stack secret, so
 * the shared counter table never holds a client address. The origin is already cut to the IPv4
 * address or the IPv6 /64 by `clientOriginOf`. The secret and the derived key are never logged.
 */
export class RateLimitOriginKeys {
  readonly #key: Buffer;

  constructor(secret: Uint8Array) {
    if (secret.length !== SECRET_BYTES) throw new TypeError('The rate-limit secret is 32 bytes');
    this.#key = Buffer.from(
      hkdfSync('sha256', secret, new Uint8Array(0), ORIGIN_KEY_INFO, SECRET_BYTES),
    );
  }

  keyOf(origin: string): string {
    if (typeof origin !== 'string' || origin.length === 0) {
      throw new TypeError('A rate-limit origin is a non-empty string');
    }
    return createHmac('sha256', this.#key).update(origin).digest('hex');
  }
}

/** The stand-in was asked to start outside an explicit development or test environment. */
export class LocalRateLimitSecretRefusedError extends Error {
  override readonly name = 'LocalRateLimitSecretRefusedError';
  constructor() {
    super(
      'The rate-limit secret is a local stand-in: it starts only when NODE_ENV is explicitly ' +
        '"development" or "test". The deployed secret (32 random bytes) is not wired yet',
    );
  }
}

/**
 * The local and CI stand-in of the rate-limit secret, like catalog's and certification's:
 * derived from a constant of this file, so it is NOT a secret, which is why it refuses to start
 * unless `NODE_ENV` was explicitly set to `development` or `test`. Where the deployed secret
 * lives is Kazem's decision with the first deployed environment (K1).
 */
export function localRateLimitSecret(
  environment: Pick<AppConfig, 'nodeEnv' | 'nodeEnvExplicit'>,
): Uint8Array {
  const { nodeEnv, nodeEnvExplicit } = environment;
  if (nodeEnvExplicit !== true || (nodeEnv !== 'development' && nodeEnv !== 'test')) {
    throw new LocalRateLimitSecretRefusedError();
  }
  new Logger('RateLimitOriginKeys').warn({
    msg: 'platform.rate-limit.secret.local-stand-in',
    nodeEnv,
    note: 'rate-limit origin keys use the local stand-in secret, which protects nothing',
  });
  return new Uint8Array(
    createHash('sha256').update('mondapac.platform.rate-limit.secret.stand-in.v1').digest(),
  );
}
