import { Global, Module } from '@nestjs/common';
import type { AppConfig } from '../config/app-config';
import { APP_CONFIG } from '../config/config.module';
import { MAIL_TRANSPORT, type MailTransport } from './mail-transport';
import { MailpitHttpTransport, UnconfiguredMailTransport } from './mailpit-http-transport';

/** The local catcher is a stand-in; it is refused unless the environment says so explicitly. */
export class MailCatcherNotAllowedError extends Error {
  override readonly name = 'MailCatcherNotAllowedError';
  constructor() {
    super(
      'MAIL_CATCHER_URL is a local stand-in: set NODE_ENV explicitly to development or test, ' +
        'or unset MAIL_CATCHER_URL',
    );
  }
}

/** Chooses the adapter from the configuration (identity design 9). */
export function mailTransportFor(config: AppConfig): MailTransport {
  if (config.mailCatcherUrl === null) return new UnconfiguredMailTransport();
  if (!config.nodeEnvExplicit || config.nodeEnv === 'production') {
    throw new MailCatcherNotAllowedError();
  }
  return new MailpitHttpTransport(config.mailCatcherUrl);
}

/** Global: exports the port's token only (identity design 9; ADR-0023, note on ADR-0008). */
@Global()
@Module({
  providers: [{ provide: MAIL_TRANSPORT, inject: [APP_CONFIG], useFactory: mailTransportFor }],
  exports: [MAIL_TRANSPORT],
})
export class MailModule {}
