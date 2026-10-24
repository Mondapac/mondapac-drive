import type { TestingModuleBuilder } from '@nestjs/testing';
import { IDENTITY_MARKET_POLICY } from '../../src/modules/identity/application/ports/identity-market-policy';
import type { IdentityMarketPolicy } from '../../src/modules/identity/application/ports/identity-market-policy';
import { MarketConfigIdentityPolicy } from '../../src/modules/identity/infrastructure/market-config-identity-policy';
import { MarketRegistry } from '../../src/platform/market-config/market-registry';

/**
 * Overrides the custom-role limit (identity design 2.3; slice 10) with a small number, so a test
 * reaches the limit cheaply, or with null (a Market without the key: create fails closed). The
 * real Market files configure 20 and 50; tests that need those use no override.
 */
export function withRoleLimit(
  builder: TestingModuleBuilder,
  limit: number | null,
): TestingModuleBuilder {
  return builder.overrideProvider(IDENTITY_MARKET_POLICY).useFactory({
    factory: (markets: MarketRegistry): IdentityMarketPolicy =>
      Object.assign(
        Object.create(new MarketConfigIdentityPolicy(markets)) as IdentityMarketPolicy,
        {
          customRoleLimit: () => limit,
        },
      ),
    inject: [MarketRegistry],
  });
}
