import { randomBytes, randomInt } from 'node:crypto';
import type { Id, MarketContext } from '@mondapac-drive/shared-kernel';
import { fieldLabel, hashPurpose } from '../../../../platform/subject-keys/labels';
import type { SubjectKeyService } from '../../../../platform/subject-keys/subject-key-service';
import {
  SecondFactorKeyUnavailableError,
  type SecondFactorSecrets,
} from '../../application/ports/second-factor-secrets';
import { parseRecoveryCode, RECOVERY_CODES, type RecoveryCode } from '../../domain/recovery-code';
import { TOTP } from '../../domain/totp';
import { matchingStep } from './totp';

/** The label of the encrypted secret (identity design 7.5): bound into its ciphertext. */
export const SECOND_FACTOR_SECRET = fieldLabel('identity.second-factor.secret');
/** The purpose of the recovery-code hash (Hassan H2): a key of its own, derived per account. */
export const RECOVERY_CODE_HASH = hashPurpose('identity.recovery-code');

/** The secret as the text that is encrypted: base64url of the 20 bytes, no padding. */
const encodeSecret = (secret: Uint8Array): string => Buffer.from(secret).toString('base64url');

/**
 * {@link SecondFactorSecrets} over the platform's `SubjectKeyService` (identity design 7.1, 7.3,
 * 7.5; data design 3.10): the secret is sealed under the account's key with its own label, and a
 * recovery code is hashed with the account's key under its own purpose. Nothing is logged here.
 *
 * A destroyed key (erasure) throws {@link SecondFactorKeyUnavailableError} (slice 7b, Hassan I-3);
 * a ciphertext that does not open under this account's key and label (another account's, another
 * label's, or altered) throws the service's `SubjectKeyIntegrityError` (Hassan L-1). Neither is
 * ever a match. The decoded secret buffer is
 * zeroed after use, but that is best effort only: the base64url strings that `seal` takes and
 * `decrypt` returns are JavaScript strings, which cannot be zeroed and live until the garbage
 * collector reclaims them (Hassan I-5).
 */
export class SubjectKeySecondFactorSecrets implements SecondFactorSecrets {
  constructor(private readonly subjectKeys: SubjectKeyService) {}

  newSecret(): Uint8Array {
    return new Uint8Array(randomBytes(TOTP.secretBytes));
  }

  async seal(market: MarketContext, accountId: Id<'Account'>, secret: Uint8Array): Promise<string> {
    if (secret.length !== TOTP.secretBytes) {
      throw new RangeError(`seal: a secret has ${TOTP.secretBytes} bytes`);
    }
    const sealed = await this.subjectKeys.encrypt(
      market,
      accountId,
      SECOND_FACTOR_SECRET,
      encodeSecret(secret),
    );
    if (!sealed.ok) throw new SecondFactorKeyUnavailableError();
    return sealed.value;
  }

  async matchStored(
    market: MarketContext,
    accountId: Id<'Account'>,
    secretCiphertext: string,
    code: string,
    steps: readonly number[],
  ): Promise<number | null> {
    const opened = await this.subjectKeys.decrypt(
      market,
      accountId,
      SECOND_FACTOR_SECRET,
      secretCiphertext,
    );
    // A destroyed key throws like an integrity failure (Hassan L-1): the caller gives both, and
    // an unreachable key service, the one refusal of a wrong code and logs an alarm (I-3).
    if (!opened.ok) throw new SecondFactorKeyUnavailableError();
    const secret = Buffer.from(opened.value, 'base64url');
    try {
      if (secret.length !== TOTP.secretBytes) return null;
      return matchingStep(secret, code, steps);
    } finally {
      secret.fill(0);
    }
  }

  matchPlain(secret: Uint8Array, code: string, steps: readonly number[]): number | null {
    if (secret.length !== TOTP.secretBytes) return null;
    return matchingStep(secret, code, steps);
  }

  newRecoveryCodes(): RecoveryCode[] {
    const codes = new Set<string>();
    while (codes.size < RECOVERY_CODES.count) {
      let code = '';
      for (let k = 0; k < RECOVERY_CODES.length; k += 1) {
        code += RECOVERY_CODES.alphabet[randomInt(RECOVERY_CODES.alphabet.length)];
      }
      codes.add(code);
    }
    return [...codes].map((code) => {
      const parsed = parseRecoveryCode(code);
      if (parsed === null) throw new Error('newRecoveryCodes: a generated code is malformed');
      return parsed;
    });
  }

  async recoveryCodeHash(
    market: MarketContext,
    accountId: Id<'Account'>,
    code: RecoveryCode,
  ): Promise<Uint8Array> {
    const hashed = await this.subjectKeys.hmac(
      market,
      accountId,
      RECOVERY_CODE_HASH,
      Buffer.from(code, 'utf8'),
    );
    if (!hashed.ok) throw new SecondFactorKeyUnavailableError();
    const bytes = Buffer.from(hashed.value, 'hex');
    if (bytes.length !== 32) throw new Error('recoveryCodeHash: the keyed hash is not 32 bytes');
    return new Uint8Array(bytes);
  }
}
