import { anonymousActor, systemActor } from './actor-context';
import type { ActorContext } from './actor-context';
import { ContextMismatchError, createCallContext } from './call-context';
import { parseCorrelationId } from './correlation-id';
import type { CorrelationId } from './correlation-id';
import { isMinted } from './minted';
import { mintMarketContext, parseMarketId, parseTenantId } from './market-context';
import type { MarketContext } from './market-context';

const MARKETS = ['AU', 'ZZ'] as const;

function market(code: string): MarketContext {
  const marketId = parseMarketId(code);
  const tenantId = parseTenantId('mondapac');
  if (!marketId.ok || !tenantId.ok) throw new Error('test setup: bad market');
  return mintMarketContext(marketId.value, tenantId.value);
}

function correlation(text: string): CorrelationId {
  const parsed = parseCorrelationId(text);
  if (!parsed.ok) throw new Error('test setup: bad correlation id');
  return parsed.value;
}

const CORRELATION = correlation('call-context-test-0001');

describe.each(MARKETS)('createCallContext for %s (foundations 3.7, 5.2)', (code) => {
  const context = market(code);
  const other = market(code === 'AU' ? 'ZZ' : 'AU');

  it('mints one frozen value holding the very parts it was given', () => {
    const actor = systemActor(context);
    const call = createCallContext(context, actor, CORRELATION);

    expect(isMinted(call)).toBe(true);
    expect(Object.isFrozen(call)).toBe(true);
    expect(call.market).toBe(context);
    expect(call.actor).toBe(actor);
    expect(call.correlationId).toBe(CORRELATION);
    expect(Object.keys(call).sort()).toEqual(['actor', 'correlationId', 'market']);
  });

  it('refuses an actor of the other Market (rule 3 of 5.2: valid only in its own Market)', () => {
    expect(() => createCallContext(context, anonymousActor(other), CORRELATION)).toThrow(
      ContextMismatchError,
    );
    try {
      createCallContext(context, systemActor(other), CORRELATION);
    } catch (error) {
      expect(error).toMatchObject({ name: 'ContextMismatchError', reason: 'market-mismatch' });
    }
  });

  it.each([
    ['a literal actor', () => [context, { kind: 'system', marketId: code }]],
    ['a copied actor', () => [context, { ...systemActor(context) }]],
    ['a literal market', () => [{ marketId: code, tenantId: 'mondapac' }, systemActor(context)]],
  ] as const)('refuses %s as not minted', (_case, parts) => {
    const [forgedMarket, forgedActor] = parts();
    try {
      createCallContext(forgedMarket as MarketContext, forgedActor as ActorContext, CORRELATION);
      throw new Error('expected a refusal');
    } catch (error) {
      expect(error).toBeInstanceOf(ContextMismatchError);
      expect(error).toMatchObject({ reason: 'not-minted' });
    }
  });

  it('refuses a correlation id outside its pattern, as a programmer error', () => {
    expect(() =>
      createCallContext(context, systemActor(context), 'short' as CorrelationId),
    ).toThrow(TypeError);
  });

  it('cannot be copied: a spread or a JSON round trip is not minted', () => {
    const call = createCallContext(context, systemActor(context), CORRELATION);

    expect(isMinted({ ...call })).toBe(false);
    expect(isMinted(JSON.parse(JSON.stringify(call)))).toBe(false);
  });
});
