import { Global, Module } from '@nestjs/common';
import type { Clock } from '@mondapac-drive/shared-kernel';
import { CLOCK } from '../clock/clock.module';
import type { AppConfig } from '../config/app-config';
import { APP_CONFIG } from '../config/config.module';
import { PersistenceModule } from '../persistence/persistence.module';
import { KEY_WRAPPER, type KeyWrapper } from './key-wrapper';
import { LocalKeyWrapper } from './local-key-wrapper';
import { NodeSubjectKeyService } from './node-subject-key-service';
import { SUBJECT_KEY_SERVICE } from './subject-key-service';
import { SUBJECT_KEY_STORE, type SubjectKeyStore } from './subject-key-store';

/**
 * Subject keys (platform-foundations design 4, row 13). Global; exports the service token only.
 * The store comes from the persistence module, which implements it, and is bound here and
 * nowhere else; neither it nor the wrapper is exported. The wrapping key is the
 * local stand-in until the deployed adapter exists, and the stand-in refuses production, so a
 * production start fails here rather than run with a key that protects nothing.
 */
@Global()
@Module({
  providers: [
    PersistenceModule.subjectKeyStore(),
    {
      provide: KEY_WRAPPER,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => new LocalKeyWrapper(config),
    },
    {
      provide: SUBJECT_KEY_SERVICE,
      inject: [SUBJECT_KEY_STORE, KEY_WRAPPER, CLOCK],
      useFactory: (store: SubjectKeyStore, wrapper: KeyWrapper, clock: Clock) =>
        new NodeSubjectKeyService(store, wrapper, clock),
    },
  ],
  exports: [SUBJECT_KEY_SERVICE],
})
export class SubjectKeysModule {}
