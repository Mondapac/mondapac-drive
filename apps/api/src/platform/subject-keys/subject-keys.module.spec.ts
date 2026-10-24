import { MODULE_METADATA } from '@nestjs/common/constants';
import { KEY_WRAPPER } from './key-wrapper';
import { SUBJECT_KEY_SERVICE } from './subject-key-service';
import { SUBJECT_KEY_STORE } from './subject-key-store';
import { SubjectKeysModule } from './subject-keys.module';

describe('SubjectKeysModule (platform-foundations design 4, row 13)', () => {
  it('exports the service only: never the key store or the wrapper', () => {
    const providers = (
      Reflect.getMetadata(MODULE_METADATA.PROVIDERS, SubjectKeysModule) as { provide: unknown }[]
    ).map((provider) => provider.provide);

    expect(Reflect.getMetadata(MODULE_METADATA.EXPORTS, SubjectKeysModule)).toEqual([
      SUBJECT_KEY_SERVICE,
    ]);
    expect(providers).toEqual([SUBJECT_KEY_STORE, KEY_WRAPPER, SUBJECT_KEY_SERVICE]);
  });
});
