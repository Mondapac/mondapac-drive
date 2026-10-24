import { join } from 'node:path';
import { marketId } from '@mondapac-drive/shared-kernel';
import { JsonMarketSettingsProvider } from '../../src/modules/delivery/infrastructure/json-market-settings.provider';
import { repositoryRoot } from '../../src/platform/platform.module';

const root = repositoryRoot(__dirname);

/** The real AU file plus the synthetic ZZ market (different currency, tax and limits). */
export const markets = new JsonMarketSettingsProvider(
  ['AU', 'ZZ'],
  [join(root, 'config', 'markets'), join(root, 'test', 'fixtures', 'markets')],
);

export const AU = marketId('AU');
export const ZZ = marketId('ZZ');
