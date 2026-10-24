import { anonymousActor, mintAuthenticatedActor, POPULATIONS, systemActor } from './actor-context';
import type { ActorContext, AuthenticatedActorFields } from './actor-context';
import { parseId } from './id';
import type { Id } from './id';
import { isMinted } from './minted';
import { mintMarketContext, parseMarketId, parseTenantId } from './market-context';
import type { MarketContext } from './market-context';

// Both market fixtures (ADR-0003 decision 9): the launch Market and the synthetic one.
const MARKETS = ['AU', 'ZZ'] as const;

function market(code: string): MarketContext {
  const marketId = parseMarketId(code);
  const tenantId = parseTenantId('mondapac');
  if (!marketId.ok || !tenantId.ok) throw new Error('test setup: bad market');
  return mintMarketContext(marketId.value, tenantId.value);
}

function id<K extends string>(text: string): Id<K> {
  const parsed = parseId<K>(text);
  if (!parsed.ok) throw new Error(`test setup: bad id ${text}`);
  return parsed.value;
}

const ACCOUNT = id<'Account'>('01890a5d-ac96-774b-bcce-b302099a8057');
const SESSION = id<'Session'>('01890a5d-ac96-774b-bcce-b302099a8058');
const MERCHANT = id<'Merchant'>('01890a5d-ac96-774b-bcce-b302099a8059');

const courier = (): AuthenticatedActorFields => ({
  population: 'courier',
  accountId: ACCOUNT,
  sessionId: SESSION,
  merchantId: null,
});

describe.each(MARKETS)('actors of market %s (identity design 4; foundations 3.4)', (code) => {
  const context = market(code);

  it.each([
    ['anonymous', anonymousActor],
    ['system', systemActor],
  ] as const)('mints the %s actor with the Market and nothing else', (kind, build) => {
    const actor = build(context);

    expect(actor).toEqual({ kind, marketId: code });
    expect(isMinted(actor)).toBe(true);
    expect(Object.isFrozen(actor)).toBe(true);
  });

  it('mints a new value on every call', () => {
    expect(anonymousActor(context)).not.toBe(anonymousActor(context));
  });

  it.each([
    ['a literal', { marketId: code, tenantId: 'mondapac' }],
    ['a spread copy', { ...context }],
    ['a JSON round trip', JSON.parse(JSON.stringify(context)) as unknown],
  ])('refuses %s in place of a minted MarketContext', (_case, forged) => {
    expect(() => anonymousActor(forged as MarketContext)).toThrow(TypeError);
    expect(() => systemActor(forged as MarketContext)).toThrow(TypeError);
  });

  it('mints an authenticated actor of the population courier, without a merchant', () => {
    const actor = mintAuthenticatedActor(context, courier());

    expect(actor).toEqual({ kind: 'authenticated', marketId: code, ...courier() });
    expect(isMinted(actor)).toBe(true);
    expect(Object.isFrozen(actor)).toBe(true);
  });

  it('mints a merchant actor only with its merchant (rule 1 of identity design 4)', () => {
    const merchant = { ...courier(), population: 'merchant' as const, merchantId: MERCHANT };

    expect(mintAuthenticatedActor(context, merchant).merchantId).toBe(MERCHANT);
    expect(() => mintAuthenticatedActor(context, { ...merchant, merchantId: null })).toThrow(
      TypeError,
    );
  });

  it.each(['courier', 'admin'] as const)(
    'refuses a %s actor that carries a merchant id',
    (population) => {
      expect(() =>
        mintAuthenticatedActor(context, { ...courier(), population, merchantId: MERCHANT }),
      ).toThrow(TypeError);
    },
  );

  it.each<[string, Partial<Record<keyof AuthenticatedActorFields, unknown>>]>([
    ['an unknown population', { population: 'staff' }],
    ['a malformed account id', { accountId: 'not-an-id' }],
    ['a malformed session id', { sessionId: '01890A5D-AC96-774B-BCCE-B302099A8058' }],
    ['a token in place of the session id', { sessionId: 'a'.repeat(43) }],
    ['a malformed merchant id', { population: 'merchant', merchantId: 'x' }],
  ])('refuses %s', (_case, override) => {
    expect(() =>
      mintAuthenticatedActor(context, {
        ...courier(),
        ...override,
      } as AuthenticatedActorFields),
    ).toThrow(TypeError);
  });

  it('copies only the declared fields: nothing extra travels in the actor', () => {
    const actor = mintAuthenticatedActor(context, {
      ...courier(),
      roles: ['admin'],
      email: 'person@example.test',
    } as AuthenticatedActorFields);

    expect(Object.keys(actor).sort()).toEqual(
      ['accountId', 'kind', 'marketId', 'population', 'merchantId', 'sessionId'].sort(),
    );
  });
});

describe('ActorContext', () => {
  it('names the three populations of Drive', () => {
    expect(POPULATIONS).toEqual(['admin', 'merchant', 'courier']);
  });

  it('is a closed union on kind: a switch over it is exhaustive', () => {
    const describe = (actor: ActorContext): string => {
      switch (actor.kind) {
        case 'anonymous':
          return 'anonymous';
        case 'system':
          return 'system';
        case 'authenticated':
          return actor.population;
      }
    };

    expect(describe(systemActor(market('AU')))).toBe('system');
  });
});
