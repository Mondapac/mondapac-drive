import { Global, Module } from '@nestjs/common';
import type { AppConfig } from '../config/app-config';
import { APP_CONFIG } from '../config/config.module';
import { LocaleCatalogues, loadLocaleCatalogues } from './locale-catalogues';

/** Loads the translation catalogues at startup; an invalid catalogue stops the boot (INTL-11). */
@Global()
@Module({
  providers: [
    {
      provide: LocaleCatalogues,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => loadLocaleCatalogues(config.localeConfigDirs),
    },
  ],
  exports: [LocaleCatalogues],
})
export class I18nModule {}
