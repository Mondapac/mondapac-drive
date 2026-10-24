import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { Logger } from '@nestjs/common';
import type { AppConfig } from '../config/app-config';
import { lengthPrefixed } from './envelope';
import type { KeyBinding, KeyWrapper, WrappedKey } from './key-wrapper';
import { SubjectKeyIntegrityError } from './subject-key-service';

const FORMAT = 'lw1';
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const DATA_KEY_BYTES = 32;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

/**
 * The local and CI stand-in of the regional wrapping key (PF 4 row 10). Its key is derived
 * from a constant of this file: it is NOT a secret and protects nothing, which is why the
 * wrapper refuses to start in production. Development and CI data are synthetic. The deployed
 * adapter (a key service holding the real wrapping key) is Kazem's, with the first deployed
 * environment; the wrapped-key format and the identifier are his too (data design 11.4, K1).
 */
export const LOCAL_WRAPPING_KEY_ID = 'local-stand-in-1';

/** The stand-in was asked to start outside an explicit development or test environment. */
export class LocalKeyWrapperRefusedError extends Error {
  override readonly name = 'LocalKeyWrapperRefusedError';
  constructor() {
    super(
      'The local key wrapper is a stand-in: it starts only when NODE_ENV is explicitly ' +
        '"development" or "test"',
    );
  }
}

/**
 * Starts only when `NODE_ENV` was explicitly set to `development` or `test` (security review
 * of slice 1c, M2): the configuration's default (`development`) is not enough, so a deployment
 * that forgets `NODE_ENV` refuses to start instead of protecting keys with a public constant.
 * It logs a warning that names the stand-in at start.
 */
export class LocalKeyWrapper implements KeyWrapper {
  readonly #key = createHash('sha256').update('mondapac.local-key-wrapper.stand-in.v1').digest();

  constructor(environment: Pick<AppConfig, 'nodeEnv' | 'nodeEnvExplicit'>) {
    const { nodeEnv, nodeEnvExplicit } = environment;
    if (nodeEnvExplicit !== true || (nodeEnv !== 'development' && nodeEnv !== 'test')) {
      throw new LocalKeyWrapperRefusedError();
    }
    new Logger('LocalKeyWrapper').warn({
      msg: 'subject-keys.local-stand-in',
      wrappingKeyId: LOCAL_WRAPPING_KEY_ID,
      nodeEnv,
      note: 'subject keys are wrapped by the local stand-in, which protects nothing',
    });
  }

  wrap(binding: KeyBinding, dataKey: Uint8Array): Promise<WrappedKey> {
    if (dataKey.length !== DATA_KEY_BYTES) throw new TypeError('A data key is 32 bytes');
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.#key, nonce, { authTagLength: TAG_BYTES });
    cipher.setAAD(bound(binding));
    const body = Buffer.concat([cipher.update(dataKey), cipher.final()]);
    const envelope = Buffer.concat([nonce, body, cipher.getAuthTag()]).toString('base64url');
    return Promise.resolve({
      wrappedKey: `${FORMAT}.${envelope}`,
      wrappingKeyId: LOCAL_WRAPPING_KEY_ID,
    });
  }

  unwrap(binding: KeyBinding, wrapped: WrappedKey): Promise<Uint8Array> {
    try {
      const prefix = `${FORMAT}.`;
      const encoded = wrapped.wrappedKey.slice(prefix.length);
      if (
        wrapped.wrappingKeyId !== LOCAL_WRAPPING_KEY_ID ||
        !wrapped.wrappedKey.startsWith(prefix) ||
        !BASE64URL.test(encoded)
      ) {
        throw new Error('format');
      }
      const bytes = Buffer.from(encoded, 'base64url');
      if (bytes.length !== NONCE_BYTES + DATA_KEY_BYTES + TAG_BYTES) throw new Error('length');
      const decipher = createDecipheriv('aes-256-gcm', this.#key, bytes.subarray(0, NONCE_BYTES), {
        authTagLength: TAG_BYTES,
      });
      decipher.setAAD(bound(binding));
      decipher.setAuthTag(bytes.subarray(NONCE_BYTES + DATA_KEY_BYTES));
      const dataKey = Buffer.concat([
        decipher.update(bytes.subarray(NONCE_BYTES, NONCE_BYTES + DATA_KEY_BYTES)),
        decipher.final(),
      ]);
      return Promise.resolve(dataKey);
    } catch {
      // Never an erasure (PF 4 row 7); the cause is dropped, it may carry input.
      return Promise.reject(new SubjectKeyIntegrityError('unwrap'));
    }
  }
}

const bound = (binding: KeyBinding): Buffer =>
  lengthPrefixed([
    'mondapac.key-wrap.v1',
    binding.marketId,
    binding.subjectId,
    String(binding.keyVersion),
  ]);
