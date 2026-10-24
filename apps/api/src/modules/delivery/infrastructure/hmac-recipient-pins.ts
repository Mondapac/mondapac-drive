import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { Logger } from '@nestjs/common';
import type { Id, MarketContext } from '@mondapac-drive/shared-kernel';
import type { AppConfig } from '../../../platform/config/app-config';
import type { RecipientPins } from '../application/ports';

/** The PIN key is missing or too short where a real one is required. */
export class PinKeyRefusedError extends Error {
  override readonly name = 'PinKeyRefusedError';
  constructor(reason: string) {
    super(`DELIVERY_PIN_KEY: ${reason}`);
  }
}

/** The fewest bytes the PIN key may have. */
export const MIN_PIN_KEY_BYTES = 32;

/**
 * The deployment's PIN key: `DELIVERY_PIN_KEY`, base64 of at least 32 random bytes. When it is
 * unset and `NODE_ENV` is explicitly `development` or `test`, a stand-in derived from a constant
 * of this file is used, which protects nothing; anywhere else an unset or short key stops the
 * process at start-up. The value is never logged. Changing the key changes every open
 * delivery's PIN, so it is rotated only between deliveries.
 */
export function pinKey(
  env: Readonly<Record<string, string | undefined>>,
  environment: Pick<AppConfig, 'nodeEnv' | 'nodeEnvExplicit'>,
): Uint8Array {
  const raw = env.DELIVERY_PIN_KEY;
  if (raw !== undefined && raw !== '') {
    if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(raw)) throw new PinKeyRefusedError('not base64');
    const key = Buffer.from(raw, raw.includes('-') || raw.includes('_') ? 'base64url' : 'base64');
    if (key.length < MIN_PIN_KEY_BYTES) {
      throw new PinKeyRefusedError(`at least ${MIN_PIN_KEY_BYTES} bytes`);
    }
    return new Uint8Array(key);
  }
  const { nodeEnv, nodeEnvExplicit } = environment;
  if (nodeEnvExplicit !== true || (nodeEnv !== 'development' && nodeEnv !== 'test')) {
    throw new PinKeyRefusedError('required outside an explicit development or test run');
  }
  new Logger('DeliveryPinKey').warn({
    msg: 'delivery.pin-key.local-stand-in',
    nodeEnv,
    note: 'recipient PINs derive from the local stand-in key, which protects nothing',
  });
  return new Uint8Array(
    createHash('sha256').update('mondapac-drive.delivery.pin-key.stand-in.v1').digest(),
  );
}

/**
 * {@link RecipientPins} by HMAC-SHA256 of the Market, tenant and delivery id under the PIN key:
 * the first 8 bytes of the tag, as an unsigned integer, modulo 10^length (the bias is below
 * 10^-10). Nothing is stored, so there is no hash to steal and nothing to keep in step.
 */
export class HmacRecipientPins implements RecipientPins {
  readonly #key: Uint8Array;

  constructor(key: Uint8Array) {
    this.#key = key;
  }

  pinFor(market: MarketContext, deliveryId: Id<'Delivery'>, length: number): string {
    if (!Number.isInteger(length) || length < 4 || length > 8) {
      throw new RangeError('a PIN has 4 to 8 digits');
    }
    const tag = createHmac('sha256', this.#key)
      .update(`delivery-pin.v1|${market.marketId}|${market.tenantId}|${deliveryId}`)
      .digest();
    const value = tag.readBigUInt64BE(0) % 10n ** BigInt(length);
    return value.toString().padStart(length, '0');
  }

  matches(
    market: MarketContext,
    deliveryId: Id<'Delivery'>,
    length: number,
    candidate: string,
  ): boolean {
    const expected = Buffer.from(this.pinFor(market, deliveryId, length), 'latin1');
    // Compared over the expected length whatever the candidate's, so the time says nothing.
    const offered = Buffer.alloc(expected.length);
    offered.write(candidate.slice(0, expected.length), 'latin1');
    return timingSafeEqual(expected, offered) && candidate.length === expected.length;
  }
}
