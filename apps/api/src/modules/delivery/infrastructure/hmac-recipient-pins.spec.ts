import type { Id } from '@mondapac-drive/shared-kernel';
import { testMarketContext } from '@mondapac-drive/shared-kernel/testing';
import { HmacRecipientPins, pinKey, PinKeyRefusedError } from './hmac-recipient-pins';

const KEY = new Uint8Array(32).fill(7);
const A = '0190a000-0000-7000-8000-000000000001' as Id<'Delivery'>;
const B = '0190a000-0000-7000-8000-000000000002' as Id<'Delivery'>;

describe.each([
  ['AU', 4],
  ['ZZ', 6],
] as const)('recipient PINs in market %s', (code, length) => {
  const market = testMarketContext(code, 'platform');
  const pins = new HmacRecipientPins(KEY);

  it('derives the same PIN of the Market length for a delivery, and another for another', () => {
    const pin = pins.pinFor(market, A, length);
    expect(pin).toMatch(new RegExp(`^[0-9]{${length}}$`));
    expect(pins.pinFor(market, A, length)).toBe(pin);
    const others = [
      B,
      '0190a000-0000-7000-8000-000000000003',
      '0190a000-0000-7000-8000-000000000004',
    ];
    expect(others.some((id) => pins.pinFor(market, id as Id<'Delivery'>, length) !== pin)).toBe(
      true,
    );
  });

  it('matches only the exact PIN', () => {
    const pin = pins.pinFor(market, A, length);
    expect(pins.matches(market, A, length, pin)).toBe(true);
    expect(pins.matches(market, A, length, `${pin}0`)).toBe(false);
    expect(pins.matches(market, A, length, pin.slice(1))).toBe(false);
    const wrong = pin.replace(/^./, (digit) => String((Number(digit) + 1) % 10));
    expect(pins.matches(market, A, length, wrong)).toBe(false);
    expect(pins.matches(market, A, length, '')).toBe(false);
  });

  it('gives another key another PIN', () => {
    const other = new HmacRecipientPins(new Uint8Array(32).fill(8));
    const ids = [A, B, '0190a000-0000-7000-8000-000000000003'] as Id<'Delivery'>[];
    expect(
      ids.some((id) => other.pinFor(market, id, length) !== pins.pinFor(market, id, length)),
    ).toBe(true);
  });
});

it('ties the PIN to the Market', () => {
  const pins = new HmacRecipientPins(KEY);
  const ids = [A, B, '0190a000-0000-7000-8000-000000000003'] as Id<'Delivery'>[];
  const au = testMarketContext('AU', 'platform');
  const zz = testMarketContext('ZZ', 'platform');
  expect(ids.some((id) => pins.pinFor(au, id, 6) !== pins.pinFor(zz, id, 6))).toBe(true);
});

describe('the PIN key', () => {
  const production = { nodeEnv: 'production', nodeEnvExplicit: true } as const;

  it('takes base64 of at least 32 bytes', () => {
    const raw = Buffer.alloc(32, 1).toString('base64');
    expect(pinKey({ DELIVERY_PIN_KEY: raw }, production)).toHaveLength(32);
    expect(() =>
      pinKey({ DELIVERY_PIN_KEY: Buffer.alloc(16).toString('base64') }, production),
    ).toThrow(PinKeyRefusedError);
    expect(() => pinKey({ DELIVERY_PIN_KEY: 'not base64!' }, production)).toThrow(
      PinKeyRefusedError,
    );
  });

  it('is required outside an explicit test or development run', () => {
    expect(() => pinKey({}, production)).toThrow(PinKeyRefusedError);
    expect(() => pinKey({}, { nodeEnv: 'test', nodeEnvExplicit: false })).toThrow(
      PinKeyRefusedError,
    );
    expect(pinKey({}, { nodeEnv: 'test', nodeEnvExplicit: true })).toHaveLength(32);
  });
});
