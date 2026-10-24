import { createHash, createHmac } from 'node:crypto';
import { Logger } from '@nestjs/common';
import type { MarketContext, Population } from '@mondapac-drive/shared-kernel';
import type { AppConfig } from '../../../../platform/config/app-config';
import type { ThrottleKeys } from '../../application/ports/session-secrets';

const SECRET_BYTES = 32;

/**
 * {@link ThrottleKeys} (identity design 6.8; data design 3.5): HMAC-SHA-256 under the stack's
 * throttle secret of 32 bytes. The parts are encoded as a JSON array, so no two different inputs
 * share a message; the first part names the key's kind, so the three kinds never collide. The
 * secret is never logged; rotating it only resets the counters.
 */
export class HmacThrottleKeys implements ThrottleKeys {
  readonly #secret: Buffer;

  constructor(secret: Uint8Array) {
    if (secret.length !== SECRET_BYTES) throw new TypeError('The throttle secret is 32 bytes');
    this.#secret = Buffer.from(secret);
  }

  account(market: MarketContext, population: Population, emailNormalized: string): Uint8Array {
    return this.key(['account', market.marketId, population, emailNormalized]);
  }

  accountOrigin(
    market: MarketContext,
    population: Population,
    emailNormalized: string,
    origin: string,
  ): Uint8Array {
    return this.key(['account-origin', market.marketId, population, emailNormalized, origin]);
  }

  origin(market: MarketContext, origin: string): Uint8Array {
    return this.key(['origin', market.marketId, origin]);
  }

  private key(parts: readonly string[]): Uint8Array {
    return new Uint8Array(
      createHmac('sha256', this.#secret).update(JSON.stringify(parts)).digest(),
    );
  }
}

/** The stand-in was asked to start outside an explicit development or test environment. */
export class LocalThrottleSecretRefusedError extends Error {
  override readonly name = 'LocalThrottleSecretRefusedError';
  constructor() {
    super(
      'The throttle secret is a local stand-in: it starts only when NODE_ENV is explicitly ' +
        '"development" or "test". The deployed secret (32 random bytes, H4) is not wired yet',
    );
  }
}

/**
 * The local and CI stand-in of the throttle secret (H4), like the local key wrapper of the
 * subject keys: derived from a constant of this file, so it is NOT a secret, which is why it
 * refuses to start unless `NODE_ENV` was explicitly set to `development` or `test`. Where the
 * deployed secret lives is Kazem's decision with the first deployed environment (data design
 * 11.4, K1); until then a production start fails here.
 */
export function localThrottleSecret(
  environment: Pick<AppConfig, 'nodeEnv' | 'nodeEnvExplicit'>,
): Uint8Array {
  const { nodeEnv, nodeEnvExplicit } = environment;
  if (nodeEnvExplicit !== true || (nodeEnv !== 'development' && nodeEnv !== 'test')) {
    throw new LocalThrottleSecretRefusedError();
  }
  new Logger('HmacThrottleKeys').warn({
    msg: 'identity.throttle-secret.local-stand-in',
    nodeEnv,
    note: 'throttle keys use the local stand-in secret, which protects nothing',
  });
  return new Uint8Array(
    createHash('sha256').update('mondapac.identity.throttle.stand-in.v1').digest(),
  );
}
