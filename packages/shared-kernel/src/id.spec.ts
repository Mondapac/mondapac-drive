import { parseId, uuidV7 } from './id';
import type { Id } from './id';

// RFC 9562 appendix A.6: 2022-02-22T19:22:22.000Z, rand_a 0xCC3, rand_b 0x18C4DC0C0C07398F.
const RFC_UNIX_MS = 0x017f22e279b0;
const RFC_RANDOM = Uint8Array.of(0x0c, 0xc3, 0x18, 0xc4, 0xdc, 0x0c, 0x0c, 0x07, 0x39, 0x8f);
const RFC_UUID = '017f22e2-79b0-7cc3-98c4-dc0c0c07398f';

const MAX_UNIX_MS = 2 ** 48 - 1;
const zeros = (): Uint8Array => new Uint8Array(10);
const ones = (): Uint8Array => new Uint8Array(10).fill(0xff);

describe('uuidV7', () => {
  it('lays out a known timestamp and known bytes as the RFC 9562 example', () => {
    expect(RFC_UNIX_MS).toBe(1645557742000);
    expect(uuidV7(RFC_UNIX_MS, RFC_RANDOM)).toBe(RFC_UUID);
  });

  it('sets the version and variant bits whatever the random bytes are', () => {
    expect(uuidV7(0, zeros())).toBe('00000000-0000-7000-8000-000000000000');
    expect(uuidV7(MAX_UNIX_MS, ones())).toBe('ffffffff-ffff-7fff-bfff-ffffffffffff');
  });

  it('uses all 74 random bits and nothing else of the 10 bytes', () => {
    // The high 4 bits of byte 0 and the high 2 bits of byte 2 are dropped.
    const random = Uint8Array.of(0xf1, 0x23, 0xc5, 0x67, 0x89, 0xab, 0xcd, 0xef, 0x01, 0x02);
    expect(uuidV7(1, random)).toBe('00000000-0001-7123-8567-89abcdef0102');
  });

  it('sorts a later millisecond later, as text', () => {
    const earlier = uuidV7(1_800_000_000_000, ones());
    const later = uuidV7(1_800_000_000_001, zeros());
    expect(earlier < later).toBe(true);
    expect(uuidV7(255, ones()) < uuidV7(256, zeros())).toBe(true);
    expect(uuidV7(2 ** 32 - 1, ones()) < uuidV7(2 ** 32, zeros())).toBe(true);
  });

  it('always produces an id that parseId accepts', () => {
    for (const unixMs of [0, 1, RFC_UNIX_MS, MAX_UNIX_MS]) {
      expect(parseId(uuidV7(unixMs, zeros())).ok).toBe(true);
      expect(parseId(uuidV7(unixMs, ones())).ok).toBe(true);
    }
  });

  it('does not change the random bytes it is given', () => {
    const random = ones();
    uuidV7(RFC_UNIX_MS, random);
    expect(Array.from(random)).toEqual(Array.from(ones()));
  });

  it.each([-1, MAX_UNIX_MS + 1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'throws RangeError on the time %p',
    (unixMs) => {
      expect(() => uuidV7(unixMs, zeros())).toThrow(RangeError);
    },
  );

  it.each([0, 9, 11, 16])('throws RangeError on %p random bytes', (length) => {
    expect(() => uuidV7(RFC_UNIX_MS, new Uint8Array(length))).toThrow(RangeError);
  });

  // Ten elements that are not ten bytes: each would pass a length check alone.
  it.each([
    ['a number array', new Array<number>(10).fill(0)],
    ['a number array of values above a byte', new Array<number>(10).fill(256)],
    ['a Uint16Array', new Uint16Array(10)],
    ['an Int8Array', new Int8Array(10)],
    ['a string of ten characters', '0123456789'],
    ['null', null],
  ])('throws RangeError on %s in place of the random bytes', (_name, random) => {
    expect(() => uuidV7(RFC_UNIX_MS, random as unknown as Uint8Array)).toThrow(RangeError);
  });
});

describe('parseId', () => {
  it('accepts the canonical lower-case text of a version 7 UUID', () => {
    const result = parseId<'Account'>(RFC_UUID);
    expect(result).toEqual({ ok: true, value: RFC_UUID });
  });

  it.each(['8', '9', 'a', 'b'])('accepts the RFC variant digit %p', (variant) => {
    expect(parseId(`017f22e2-79b0-7cc3-${variant}8c4-dc0c0c07398f`).ok).toBe(true);
  });

  it.each([
    ['upper case', '017F22E2-79B0-7CC3-98C4-DC0C0C07398F'],
    ['mixed case', '017f22e2-79b0-7cc3-98c4-dc0c0c07398F'],
    ['version 4', '017f22e2-79b0-4cc3-98c4-dc0c0c07398f'],
    ['version 1', '017f22e2-79b0-1cc3-98c4-dc0c0c07398f'],
    ['version 8', '017f22e2-79b0-8cc3-98c4-dc0c0c07398f'],
    ['the nil UUID', '00000000-0000-0000-0000-000000000000'],
    ['the max UUID', 'ffffffff-ffff-ffff-ffff-ffffffffffff'],
    ['variant 0 (NCS)', '017f22e2-79b0-7cc3-08c4-dc0c0c07398f'],
    ['variant 7 (NCS)', '017f22e2-79b0-7cc3-78c4-dc0c0c07398f'],
    ['variant c (Microsoft)', '017f22e2-79b0-7cc3-c8c4-dc0c0c07398f'],
    ['variant f (reserved)', '017f22e2-79b0-7cc3-f8c4-dc0c0c07398f'],
    ['no hyphens', '017f22e279b07cc398c4dc0c0c07398f'],
    ['braces', '{017f22e2-79b0-7cc3-98c4-dc0c0c07398f}'],
    ['a urn prefix', 'urn:uuid:017f22e2-79b0-7cc3-98c4-dc0c0c07398f'],
    ['a leading space', ' 017f22e2-79b0-7cc3-98c4-dc0c0c07398f'],
    ['a trailing newline', '017f22e2-79b0-7cc3-98c4-dc0c0c07398f\n'],
    ['a second line', '017f22e2-79b0-7cc3-98c4-dc0c0c07398f\nx'],
    ['a non-hex digit', '017f22e2-79b0-7cc3-98c4-dc0c0c07398g'],
    ['too short', '017f22e2-79b0-7cc3-98c4-dc0c0c07398'],
    ['too long', '017f22e2-79b0-7cc3-98c4-dc0c0c07398f0'],
    ['empty', ''],
    ['noise', 'not-an-id'],
  ])('rejects %s', (_name, text) => {
    expect(parseId(text)).toEqual({ ok: false, error: { code: 'id.invalid' } });
  });

  it('rejects a value that is not a string at run time', () => {
    expect(parseId([RFC_UUID] as unknown as string).ok).toBe(false);
    expect(parseId(new String(RFC_UUID) as unknown as string).ok).toBe(false);
    expect(parseId(undefined as unknown as string).ok).toBe(false);
  });

  it('brands the id by kind at compile time only', () => {
    const result = parseId<'Account'>(RFC_UUID);
    if (!result.ok) throw new Error('expected a valid id');
    const accountId: Id<'Account'> = result.value;
    // @ts-expect-error an account id is not an order id
    const orderId: Id<'Order'> = accountId;
    expect(orderId).toBe(RFC_UUID);
    expect(typeof accountId).toBe('string');
  });
});
