import { err } from '@mondapac-drive/shared-kernel';
import type { CallContext } from '@mondapac-drive/shared-kernel';
import {
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac-drive/shared-kernel/testing';
import { parseId } from '@mondapac-drive/shared-kernel';
import { createUseCaseGate } from '../../src/platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../src/platform/market-config/market-config';
import { MarketRegistry } from '../../src/platform/market-config/market-registry';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from './test-config';

/** A gate that admits every permission check, so only the `system` rule can deny. */
export function openGate() {
  const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
  return createUseCaseGate(markets, { check: () => Promise.resolve({ allowed: true }) });
}

/** A courier, a merchant, an admin and an anonymous caller of the Market. */
export function nonSystemCallers(code: 'AU' | 'ZZ'): Record<string, CallContext> {
  const market = testMarketContext(code, 'default');
  const id = (n: number) => {
    const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
    if (!parsed.ok) throw new Error('bad id');
    return parsed.value;
  };
  const actor = (population: 'courier' | 'merchant' | 'admin', n: number) =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population,
        accountId: id(n) as never,
        sessionId: id(n + 0x100) as never,
        merchantId: population === 'merchant' ? (id(n + 0x200) as never) : null,
      }),
      `denial-${population}-0001`,
    );
  return {
    courier: actor('courier', 0xc1),
    merchant: actor('merchant', 0xc2),
    admin: actor('admin', 0xc3),
    anonymous: testCallContext(market, 'anonymous', 'denial-anonymous-0001'),
  };
}

/** Every non-system caller is refused with `access.denied`, and the use case never ran. */
export async function expectSystemOnly(
  code: 'AU' | 'ZZ',
  execute: (context: CallContext) => Promise<unknown>,
): Promise<void> {
  for (const [name, context] of Object.entries(nonSystemCallers(code))) {
    expect({ name, result: await execute(context) }).toEqual({
      name,
      result: err({ code: 'access.denied' }),
    });
  }
}
