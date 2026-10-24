import { Global, Module, type DynamicModule } from '@nestjs/common';
import { loadAppConfig, type AppConfig } from './app-config';

/** Injection token for the validated {@link AppConfig}. */
export const APP_CONFIG = Symbol('APP_CONFIG');

@Global()
@Module({})
export class ConfigModule {
  /** Reads and validates `process.env`; pass `config` to override it in tests. */
  static forRoot(config?: AppConfig): DynamicModule {
    return {
      module: ConfigModule,
      providers: [{ provide: APP_CONFIG, useFactory: () => config ?? loadAppConfig(process.env) }],
      exports: [APP_CONFIG],
    };
  }
}
