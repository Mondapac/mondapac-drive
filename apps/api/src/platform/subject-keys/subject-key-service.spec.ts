import { Logger } from '@nestjs/common';
import { parseId, Temporal } from '@mondapac-drive/shared-kernel';
import type { Id, MarketContext } from '@mondapac-drive/shared-kernel';
import {
  FixedClock,
  SequenceIdGenerator,
  testMarketContext,
} from '@mondapac-drive/shared-kernel/testing';
import { TEST_MARKETS } from '../../../test/support/test-config';
import { loadAppConfig } from '../config/app-config';
import { PLATFORM_TENANT_ID } from '../market-context/tenant';
import type { KeyBinding, KeyWrapper } from './key-wrapper';
import { fieldLabel, hashPurpose } from './labels';
import { LocalKeyWrapper, LocalKeyWrapperRefusedError } from './local-key-wrapper';
import { NodeSubjectKeyService } from './node-subject-key-service';
import {
  SubjectKeyExistsError,
  SubjectKeyIntegrityError,
  SubjectKeyMissingError,
} from './subject-key-service';
import type { NewSubjectKey, StoredSubjectKey, SubjectKeyStore } from './subject-key-store';

// platform-foundations design 4 (rows 1 to 10) and 9, for both Market fixtures. The store is an
// in-memory stand-in with the table's rules; the Prisma store is tested under `pnpm test:db`.

/** One row per subject for life, visible only in its own Market; a tombstone is one-way. */
class MemoryStore implements SubjectKeyStore {
  readonly rows = new Map<string, StoredSubjectKey & { marketId: string }>();

  insert(market: MarketContext, key: NewSubjectKey): Promise<void> {
    if (this.rows.has(key.subjectId)) return Promise.reject(new SubjectKeyExistsError());
    this.rows.set(key.subjectId, { ...key, marketId: market.marketId, destroyedAt: null });
    return Promise.resolve();
  }

  find(market: MarketContext, subjectId: Id): Promise<StoredSubjectKey | null> {
    const row = this.rows.get(subjectId);
    return Promise.resolve(row?.marketId === market.marketId ? row : null);
  }

  destroy(market: MarketContext, subjectId: Id, destroyedAt: Temporal.Instant): Promise<void> {
    const row = this.rows.get(subjectId);
    if (row?.marketId !== market.marketId) return Promise.reject(new SubjectKeyMissingError());
    if (row.destroyedAt === null) {
      this.rows.set(subjectId, { ...row, wrappedKey: null, destroyedAt });
    }
    return Promise.resolve();
  }
}

const TEST_ENVIRONMENT = { nodeEnv: 'test', nodeEnvExplicit: true } as const;
const FIELD = fieldLabel('identity.second-factor.secret');
const OTHER_FIELD = fieldLabel('identity.account.display-name');
const PURPOSE = hashPurpose('identity.recovery-code');
const DESTROYED = { ok: false, error: { code: 'subject-key.destroyed' } };

describe.each(TEST_MARKETS)('NodeSubjectKeyService in market %s', (code) => {
  const market = testMarketContext(code, PLATFORM_TENANT_ID);
  const other = testMarketContext(code === 'AU' ? 'ZZ' : 'AU', PLATFORM_TENANT_ID);
  const clock = new FixedClock(Temporal.Instant.from('2026-10-07T00:00:00Z'));
  const ids = new SequenceIdGenerator(clock);
  let store: MemoryStore;
  let service: NodeSubjectKeyService;
  let subject: Id;

  beforeEach(async () => {
    store = new MemoryStore();
    service = new NodeSubjectKeyService(store, new LocalKeyWrapper(TEST_ENVIRONMENT), clock);
    subject = ids.next();
    await service.createKey(market, subject);
  });

  const unwrapped = <T>(result: { ok: boolean; value?: T }): T => {
    if (!result.ok) throw new Error('expected ok');
    return result.value as T;
  };

  it('stores one wrapped key with the version, the wrapping key id and the Clock instant', () => {
    const row = store.rows.get(subject)!;

    expect(row).toMatchObject({
      subjectId: subject,
      marketId: code,
      keyVersion: 1,
      wrappingKeyId: 'local-stand-in-1',
      createdAt: clock.now(),
    });
    expect(row.wrappedKey).toMatch(/^lw1\./);
  });

  it('encrypts and decrypts a field; the ciphertext is randomised', async () => {
    const first = unwrapped(await service.encrypt(market, subject, FIELD, 'JBSWY3DPEHPK3PXP'));
    const second = unwrapped(await service.encrypt(market, subject, FIELD, 'JBSWY3DPEHPK3PXP'));

    expect(first).not.toBe(second);
    await expect(service.decrypt(market, subject, FIELD, first)).resolves.toEqual({
      ok: true,
      value: 'JBSWY3DPEHPK3PXP',
    });
  });

  it('refuses a value copied to another field or another subject, and never as an erasure', async () => {
    const sealed = unwrapped(await service.encrypt(market, subject, FIELD, 'secret'));
    const another = ids.next();
    await service.createKey(market, another);

    await expect(service.decrypt(market, subject, OTHER_FIELD, sealed)).rejects.toBeInstanceOf(
      SubjectKeyIntegrityError,
    );
    await expect(service.decrypt(market, another, FIELD, sealed)).rejects.toBeInstanceOf(
      SubjectKeyIntegrityError,
    );
  });

  it('does not know the subject in the other Market: a key of one Market fails under the other', async () => {
    const sealed = unwrapped(await service.encrypt(market, subject, FIELD, 'secret'));

    await expect(service.decrypt(other, subject, FIELD, sealed)).rejects.toBeInstanceOf(
      SubjectKeyMissingError,
    );
    await expect(service.createKey(other, subject)).rejects.toBeInstanceOf(SubjectKeyExistsError);
  });

  it('refuses a wrapped key moved to another subject or Market (the wrap binding)', async () => {
    const moved = ids.next();
    const row = store.rows.get(subject)!;
    store.rows.set(moved, { ...row, subjectId: moved });

    await expect(service.encrypt(market, moved, FIELD, 'x')).rejects.toMatchObject({
      name: 'SubjectKeyIntegrityError',
      reason: 'unwrap',
    });

    // The same row moved to the other Market.
    store.rows.set(subject, { ...row, marketId: other.marketId });
    await expect(service.encrypt(other, subject, FIELD, 'x')).rejects.toMatchObject({
      name: 'SubjectKeyIntegrityError',
      reason: 'unwrap',
    });
  });

  it('throws on a wrapper failure; it is never reported as destroyed (PF 4 row 7)', async () => {
    const failing: KeyWrapper = {
      wrap: (binding: KeyBinding, key: Uint8Array) =>
        new LocalKeyWrapper(TEST_ENVIRONMENT).wrap(binding, key),
      unwrap: () => Promise.reject(new Error('key service unavailable')),
    };
    const broken = new NodeSubjectKeyService(store, failing, clock);

    await expect(broken.encrypt(market, subject, FIELD, 'x')).rejects.toThrow(
      'key service unavailable',
    );
    await expect(broken.hmac(market, subject, PURPOSE, new Uint8Array([1]))).rejects.toThrow();
  });

  it('hashes per subject and purpose', async () => {
    const data = new TextEncoder().encode('ABCD-EFGH');
    const another = ids.next();
    await service.createKey(market, another);

    const hash = unwrapped(await service.hmac(market, subject, PURPOSE, data));
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(unwrapped(await service.hmac(market, subject, PURPOSE, data))).toBe(hash);
    expect(unwrapped(await service.hmac(market, another, PURPOSE, data))).not.toBe(hash);
    expect(
      unwrapped(await service.hmac(market, subject, hashPurpose('identity.other'), data)),
    ).not.toBe(hash);
  });

  it('refuses a second key for the subject, also after destruction (PF 4 row 5)', async () => {
    await expect(service.createKey(market, subject)).rejects.toBeInstanceOf(SubjectKeyExistsError);
    await service.destroyKey(market, subject);
    await expect(service.createKey(market, subject)).rejects.toBeInstanceOf(SubjectKeyExistsError);
  });

  it('after destruction answers subject-key.destroyed, keeps a tombstone, and destroys idempotently', async () => {
    const sealed = unwrapped(await service.encrypt(market, subject, FIELD, 'secret'));
    clock.advance(Temporal.Duration.from({ minutes: 5 }));

    await service.destroyKey(market, subject);
    await service.destroyKey(market, subject);

    expect(store.rows.get(subject)).toMatchObject({
      wrappedKey: null,
      destroyedAt: Temporal.Instant.from('2026-10-07T00:05:00Z'),
    });
    await expect(service.decrypt(market, subject, FIELD, sealed)).resolves.toEqual(DESTROYED);
    await expect(service.encrypt(market, subject, FIELD, 'again')).resolves.toEqual(DESTROYED);
    await expect(service.hmac(market, subject, PURPOSE, new Uint8Array())).resolves.toEqual(
      DESTROYED,
    );
  });

  it('throws for a subject that never had a key (a programmer error, PF 4 row 6)', async () => {
    const unknown = ids.next();

    await expect(service.encrypt(market, unknown, FIELD, 'x')).rejects.toBeInstanceOf(
      SubjectKeyMissingError,
    );
    await expect(service.decrypt(market, unknown, FIELD, 'v1.AAAA')).rejects.toBeInstanceOf(
      SubjectKeyMissingError,
    );
    await expect(service.hmac(market, unknown, PURPOSE, new Uint8Array())).rejects.toBeInstanceOf(
      SubjectKeyMissingError,
    );
    await expect(service.destroyKey(market, unknown)).rejects.toBeInstanceOf(
      SubjectKeyMissingError,
    );
  });

  it('refuses a subject that is not a parsed id', async () => {
    await expect(service.createKey(market, 'not-an-id' as Id)).rejects.toBeInstanceOf(TypeError);
    expect(parseId(subject).ok).toBe(true);
  });
});

describe('LocalKeyWrapper', () => {
  let warnings: jest.SpyInstance;

  beforeEach(() => {
    warnings = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnings.mockRestore();
  });

  it('refuses to start in production (PF 4 row 10)', () => {
    expect(() => new LocalKeyWrapper({ nodeEnv: 'production', nodeEnvExplicit: true })).toThrow(
      LocalKeyWrapperRefusedError,
    );
  });

  it('refuses to start when NODE_ENV was not set, though the configuration defaults it (M2)', () => {
    const defaulted = loadAppConfig({
      APP_ROLE: 'api',
      HOSTED_MARKETS: 'AU',
      DATABASE_URL: 'postgresql://user:secret@localhost:5432/db',
    });

    expect(defaulted.nodeEnv).toBe('development');
    expect(() => new LocalKeyWrapper(defaulted)).toThrow(LocalKeyWrapperRefusedError);
    expect(warnings).not.toHaveBeenCalled();
  });

  it.each(['development', 'test'] as const)(
    'starts when NODE_ENV is explicitly %s, with a warning that names the stand-in',
    (nodeEnv) => {
      expect(() => new LocalKeyWrapper({ nodeEnv, nodeEnvExplicit: true })).not.toThrow();
      expect(warnings).toHaveBeenCalledWith(
        expect.objectContaining({
          msg: 'subject-keys.local-stand-in',
          wrappingKeyId: 'local-stand-in-1',
          nodeEnv,
        }),
      );
    },
  );
});
