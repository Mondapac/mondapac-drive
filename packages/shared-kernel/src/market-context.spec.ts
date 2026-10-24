import { isMinted } from './minted';
import { mintMarketContext, parseMarketId, parseTenantId } from './market-context';
import type { MarketContext, MarketId, TenantId } from './market-context';

function marketId(text: string): MarketId {
  const result = parseMarketId(text);
  if (!result.ok) throw new Error(`test setup: bad market id ${text}`);
  return result.value;
}

function tenantId(text: string): TenantId {
  const result = parseTenantId(text);
  if (!result.ok) throw new Error(`test setup: bad tenant id ${text}`);
  return result.value;
}

describe('parseMarketId', () => {
  it.each(['AU', 'ZZ', 'NZ', 'A1', 'A_', 'EU_NORTH'])('accepts %p', (text) => {
    expect(parseMarketId(text)).toEqual({ ok: true, value: text });
  });

  it.each([
    ['empty', ''],
    ['one character', 'A'],
    ['nine characters', 'ABCDEFGHI'],
    ['lower case', 'au'],
    ['mixed case', 'Au'],
    ['a leading digit', '1A'],
    ['a leading underscore', '_A'],
    ['a hyphen', 'A-U'],
    ['a leading space', ' AU'],
    ['a trailing space', 'AU '],
    ['a trailing newline', 'AU\n'],
    ['a second line', 'AU\nZZ'],
    ['a non-ASCII letter', 'AÜ'],
    ['a list', 'AU,ZZ'],
  ])('rejects %s', (_name, text) => {
    expect(parseMarketId(text)).toEqual({ ok: false, error: { code: 'market-id.invalid' } });
  });

  it('rejects a value that is not a string at run time (a repeated header is an array)', () => {
    expect(parseMarketId(['AU'] as unknown as string).ok).toBe(false);
    expect(parseMarketId(new String('AU') as unknown as string).ok).toBe(false);
    expect(parseMarketId(undefined as unknown as string).ok).toBe(false);
  });
});

describe('parseTenantId', () => {
  it.each(['mondapac', 'ab', 'tenant-2', 'a-', `a${'b'.repeat(31)}`])('accepts %p', (text) => {
    expect(parseTenantId(text)).toEqual({ ok: true, value: text });
  });

  it.each([
    ['empty', ''],
    ['one character', 'a'],
    ['thirty-three characters', `a${'b'.repeat(32)}`],
    ['upper case', 'Mondapac'],
    ['a leading digit', '1abc'],
    ['a leading hyphen', '-abc'],
    ['an underscore', 'a_b'],
    ['a trailing space', 'ab '],
    ['a trailing newline', 'ab\n'],
    ['a non-ASCII letter', 'abé'],
  ])('rejects %s', (_name, text) => {
    expect(parseTenantId(text)).toEqual({ ok: false, error: { code: 'tenant-id.invalid' } });
  });

  it('rejects a value that is not a string at run time', () => {
    expect(parseTenantId(['mondapac'] as unknown as string).ok).toBe(false);
    expect(parseTenantId(new String('mondapac') as unknown as string).ok).toBe(false);
    expect(parseTenantId(null as unknown as string).ok).toBe(false);
  });
});

describe('mintMarketContext', () => {
  // Two markets, as every market-scoped test must cover (the launch one and a synthetic one).
  it.each([
    ['AU', 'mondapac'],
    ['ZZ', 'tenant-2'],
  ])('builds a minted context for %s / %s', (market, tenant) => {
    const context = mintMarketContext(marketId(market), tenantId(tenant));

    expect(context).toEqual({ marketId: market, tenantId: tenant });
    expect(Object.keys(context).sort()).toEqual(['marketId', 'tenantId']);
    expect(Object.getOwnPropertySymbols(context)).toEqual([]);
    expect(isMinted(context)).toBe(true);
  });

  it('freezes the context', () => {
    const context = mintMarketContext(marketId('ZZ'), tenantId('mondapac'));
    const writable = context as { marketId: string; extra?: string };

    expect(Object.isFrozen(context)).toBe(true);
    expect(() => {
      writable.marketId = 'AU';
    }).toThrow(TypeError);
    expect(() => {
      writable.extra = 'x';
    }).toThrow(TypeError);
    expect(context.marketId).toBe('ZZ');
  });

  it('mints a new value every time: two contexts of one market are equal but not identical', () => {
    const first = mintMarketContext(marketId('AU'), tenantId('mondapac'));
    const second = mintMarketContext(marketId('AU'), tenantId('mondapac'));

    expect(first).not.toBe(second);
    expect(first).toEqual(second);
    expect(isMinted(first) && isMinted(second)).toBe(true);
  });

  it('refuses an identifier that did not come from the parse functions', () => {
    const good = { market: marketId('AU'), tenant: tenantId('mondapac') };

    expect(() => mintMarketContext('au' as MarketId, good.tenant)).toThrow(TypeError);
    expect(() => mintMarketContext(good.market, 'Not A Tenant' as TenantId)).toThrow(TypeError);
    expect(() => mintMarketContext(undefined as unknown as MarketId, good.tenant)).toThrow(
      TypeError,
    );
  });
});

describe('isMinted', () => {
  const minted = mintMarketContext(marketId('AU'), tenantId('mondapac'));

  it('refuses an object literal of the same shape', () => {
    // @ts-expect-error a literal lacks the brand, so it is not a MarketContext
    const literal: MarketContext = { marketId: marketId('AU'), tenantId: tenantId('mondapac') };
    const cast = { marketId: 'AU', tenantId: 'mondapac' } as unknown as MarketContext;

    expect(isMinted(literal)).toBe(false);
    expect(isMinted(cast)).toBe(false);
  });

  it('refuses a spread copy of a minted context', () => {
    const copy: MarketContext = { ...minted };

    expect(copy).toEqual(minted);
    expect(isMinted(copy)).toBe(false);
  });

  it('refuses a frozen copy and an object that inherits from a minted context', () => {
    expect(isMinted(Object.freeze({ ...minted }))).toBe(false);
    expect(isMinted(Object.create(minted))).toBe(false);
  });

  it('refuses a Proxy of a minted context, which reads the same fields', () => {
    const proxy = new Proxy(minted, {});

    expect(proxy.marketId).toBe('AU');
    expect(proxy).toEqual(minted);
    expect(isMinted(proxy)).toBe(false);
  });

  it('refuses a JSON round trip of a minted context', () => {
    const revived = JSON.parse(JSON.stringify(minted)) as MarketContext;

    expect(revived).toEqual(minted);
    expect(isMinted(revived)).toBe(false);
  });

  it.each([undefined, null, 'AU', 0, true, Symbol('x'), () => minted, [minted]])(
    'refuses %p',
    (value) => {
      expect(isMinted(value)).toBe(false);
    },
  );
});
