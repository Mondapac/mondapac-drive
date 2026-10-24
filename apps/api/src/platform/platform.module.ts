import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Global, Module } from '@nestjs/common';
import { MARKET_SETTINGS } from '../modules/delivery/application/ports.js';
import { JsonMarketSettingsProvider } from '../modules/delivery/infrastructure/json-market-settings.provider.js';
import { CLOCK, SystemClock } from './clock/clock.js';
import { ID_GENERATOR, UuidGenerator } from './ids/id-generator.js';

/** The repository root: the nearest directory above this file that holds pnpm-workspace.yaml. */
export function repositoryRoot(from = __dirname): string {
  let dir = from;
  while (!existsSync(join(dir, 'pnpm-workspace.yaml'))) {
    const parent = dirname(dir);
    if (parent === dir) throw new Error('Repository root not found');
    dir = parent;
  }
  return dir;
}

export function hostedMarkets(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.HOSTED_MARKETS ?? '')
    .split(',')
    .map((code) => code.trim())
    .filter(Boolean);
}

@Global()
@Module({
  providers: [
    { provide: CLOCK, useClass: SystemClock },
    { provide: ID_GENERATOR, useClass: UuidGenerator },
    {
      provide: MARKET_SETTINGS,
      useFactory: () =>
        new JsonMarketSettingsProvider(hostedMarkets(), [
          join(repositoryRoot(), 'config', 'markets'),
        ]),
    },
  ],
  exports: [CLOCK, ID_GENERATOR, MARKET_SETTINGS],
})
export class PlatformModule {}
