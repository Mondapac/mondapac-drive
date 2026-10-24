import { randomBytes } from 'node:crypto';
import { err, ok, parseId } from '@mondapac-drive/shared-kernel';
import type { Clock, Id, MarketContext, Result } from '@mondapac-drive/shared-kernel';
import { keyedHash, openField, sealField } from './envelope';
import type { KeyBinding, KeyWrapper } from './key-wrapper';
import type { FieldLabel, HashPurpose } from './labels';
import {
  SubjectKeyMissingError,
  type Keyed,
  type SubjectKeyDestroyed,
  type SubjectKeyService,
} from './subject-key-service';
import type { SubjectKeyStore } from './subject-key-store';

/** The only key version of Phase 2 (data design 3.2). */
const KEY_VERSION = 1;
const DATA_KEY_BYTES = 32;
const DESTROYED: SubjectKeyDestroyed = Object.freeze({ code: 'subject-key.destroyed' });

function subjectOf(subject: Id): string {
  if (!parseId(subject).ok) throw new TypeError('A subject is a parsed id');
  return subject;
}

/**
 * The {@link SubjectKeyService} on `node:crypto` (platform-foundations design 4), over the key
 * store and the regional {@link KeyWrapper}. Every data operation reads the key row and
 * unwraps it again: no unwrapped key is cached (row 9), and each is zeroed after use.
 */
export class NodeSubjectKeyService implements SubjectKeyService {
  constructor(
    private readonly store: SubjectKeyStore,
    private readonly wrapper: KeyWrapper,
    private readonly clock: Clock,
  ) {}

  async createKey(market: MarketContext, subject: Id): Promise<void> {
    const binding: KeyBinding = {
      marketId: market.marketId,
      subjectId: subjectOf(subject),
      keyVersion: KEY_VERSION,
    };
    const dataKey = randomBytes(DATA_KEY_BYTES);
    try {
      const wrapped = await this.wrapper.wrap(binding, dataKey);
      await this.store.insert(market, {
        subjectId: subject,
        keyVersion: KEY_VERSION,
        wrappedKey: wrapped.wrappedKey,
        wrappingKeyId: wrapped.wrappingKeyId,
        createdAt: this.clock.now(),
      });
    } finally {
      dataKey.fill(0);
    }
  }

  encrypt(market: MarketContext, subject: Id, field: FieldLabel, plain: string): Keyed<string> {
    return this.withDataKey(market, subject, (key) =>
      sealField(key, { marketId: market.marketId, subjectId: subject, field }, plain),
    );
  }

  decrypt(market: MarketContext, subject: Id, field: FieldLabel, cipher: string): Keyed<string> {
    return this.withDataKey(market, subject, (key) =>
      openField(key, { marketId: market.marketId, subjectId: subject, field }, cipher),
    );
  }

  hmac(market: MarketContext, subject: Id, purpose: HashPurpose, data: Uint8Array): Keyed<string> {
    return this.withDataKey(market, subject, (key) => keyedHash(key, purpose, data));
  }

  async destroyKey(market: MarketContext, subject: Id): Promise<void> {
    await this.store.destroy(market, subjectOf(subject) as Id, this.clock.now());
  }

  /** Reads and unwraps the subject's key for one operation, then zeroes it. */
  private async withDataKey<T>(
    market: MarketContext,
    subject: Id,
    use: (dataKey: Uint8Array) => T,
  ): Promise<Result<T, SubjectKeyDestroyed>> {
    const row = await this.store.find(market, subjectOf(subject) as Id);
    if (row === null) throw new SubjectKeyMissingError();
    if (row.wrappedKey === null) return err(DESTROYED);
    const dataKey = await this.wrapper.unwrap(
      { marketId: market.marketId, subjectId: subject, keyVersion: row.keyVersion },
      { wrappedKey: row.wrappedKey, wrappingKeyId: row.wrappingKeyId },
    );
    try {
      return ok(use(dataKey));
    } finally {
      dataKey.fill(0);
    }
  }
}
