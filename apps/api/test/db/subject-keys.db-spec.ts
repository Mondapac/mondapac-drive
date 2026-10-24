import { err, ok, Temporal } from '@mondapac-drive/shared-kernel';
import type { Id } from '@mondapac-drive/shared-kernel';
import { FixedClock, SequenceIdGenerator } from '@mondapac-drive/shared-kernel/testing';
import { Client } from 'pg';
import { PrismaSubjectKeyStore } from '../../src/platform/persistence/prisma-subject-key-store';
import { fieldLabel, hashPurpose } from '../../src/platform/subject-keys/labels';
import { LocalKeyWrapper } from '../../src/platform/subject-keys/local-key-wrapper';
import { NodeSubjectKeyService } from '../../src/platform/subject-keys/node-subject-key-service';
import {
  SubjectKeyExistsError,
  SubjectKeyMissingError,
} from '../../src/platform/subject-keys/subject-key-service';
import { MarketGuardError, NoUnitOfWorkError } from '../../src/platform/unit-of-work/errors';
import { TEST_MARKETS } from '../support/test-config';
import {
  createPersistence,
  marketOf,
  otherMarketOf,
  recordDriverStatements,
  type Persistence,
} from './persistence-support';
import { ownerTestDatabaseUrl, testDatabaseUrl } from './test-database';

// The SubjectKeyService on the key table `platform.subject_keys` (platform-foundations design
// 4; data design docs/design/data/identity.md 3.2 and 8.1), for both Market fixtures, as the
// application role: keys are written in the caller's unit and read back uncommitted; one key
// per subject for life, in any Market; destruction leaves a one-way tombstone that no role, the
// owner included, can revive; the application role cannot delete a row.

const FIELD = fieldLabel('identity.second-factor.secret');
const PURPOSE = hashPurpose('identity.recovery-code');

interface KeyRow {
  market_id: string;
  key_version: number;
  wrapped_key: string | null;
  wrapping_key_id: string;
  created_at: Date;
  destroyed_at: Date | null;
}

describe('subject keys (database integration)', () => {
  const clock = new FixedClock(Temporal.Instant.from('2026-10-07T00:00:00Z'));
  const ids = new SequenceIdGenerator(clock);
  let db: Persistence;
  let service: NodeSubjectKeyService;
  let app: Client;
  let owner: Client;

  beforeAll(async () => {
    db = createPersistence();
    const store = new PrismaSubjectKeyStore(db.service, db.unitOfWork);
    service = new NodeSubjectKeyService(
      store,
      new LocalKeyWrapper({ nodeEnv: 'test', nodeEnvExplicit: true }),
      clock,
    );
    app = new Client({ connectionString: testDatabaseUrl() });
    owner = new Client({ connectionString: ownerTestDatabaseUrl() });
    await app.connect();
    await owner.connect();
  });

  afterAll(async () => {
    await app.end();
    await owner.end();
    await db.close();
  });

  const rowOf = async (subject: Id): Promise<KeyRow | undefined> =>
    (
      await app.query<KeyRow>('SELECT * FROM platform.subject_keys WHERE subject_id = $1', [
        subject,
      ])
    ).rows[0];

  describe.each(TEST_MARKETS)('in market %s', (code) => {
    const market = marketOf(code);
    const other = marketOf(otherMarketOf(code));

    /** Creates a key for a new subject in a committed unit. */
    const committedSubject = async (): Promise<Id> => {
      const subject = ids.next();
      await db.unitOfWork.run(market, async () => ok(await service.createKey(market, subject)));
      return subject;
    };

    it("creates the key in the caller's unit and uses it before the unit commits", async () => {
      const subject = ids.next();

      const result = await db.unitOfWork.run(market, async () => {
        await service.createKey(market, subject);
        const sealed = await service.encrypt(market, subject, FIELD, 'JBSWY3DPEHPK3PXP');
        if (!sealed.ok) return sealed;
        return service.decrypt(market, subject, FIELD, sealed.value);
      });

      expect(result).toEqual({ ok: true, value: 'JBSWY3DPEHPK3PXP' });
      expect(await rowOf(subject)).toMatchObject({
        market_id: code,
        key_version: 1,
        wrapping_key_id: 'local-stand-in-1',
        created_at: new Date('2026-10-07T00:00:00.000Z'),
        destroyed_at: null,
      });
      expect((await rowOf(subject))!.wrapped_key).toMatch(/^lw1\./);
    });

    it('writes nothing when the unit ends in err', async () => {
      const subject = ids.next();

      await db.unitOfWork.run(market, async () => {
        await service.createKey(market, subject);
        return err('rolled-back');
      });

      expect(await rowOf(subject)).toBeUndefined();
    });

    it('needs a read-write unit to create or destroy a key', async () => {
      const subject = await committedSubject();

      await expect(service.createKey(market, ids.next())).rejects.toBeInstanceOf(NoUnitOfWorkError);
      await expect(service.destroyKey(market, subject)).rejects.toBeInstanceOf(NoUnitOfWorkError);
      await expect(
        db.unitOfWork.run(market, async () => ok(await service.createKey(market, ids.next())), {
          readOnly: true,
        }),
      ).rejects.toBeInstanceOf(MarketGuardError);
    });

    it('reads a committed key outside a unit in a read-only unit of its own (no transaction)', async () => {
      const subject = await committedSubject();
      const driver = recordDriverStatements();
      try {
        const hash = await driver.during(() =>
          service.hmac(market, subject, PURPOSE, new TextEncoder().encode('ABCD-EFGH')),
        );

        expect(hash.ok).toBe(true);
        expect(driver.statements.filter((sql) => /^\s*(BEGIN|COMMIT|SET)/i.test(sql))).toEqual([]);
      } finally {
        driver.restore();
      }
    });

    it('refuses a second key for the subject, in this Market or the other', async () => {
      const subject = await committedSubject();

      await expect(
        db.unitOfWork.run(market, async () => ok(await service.createKey(market, subject))),
      ).rejects.toBeInstanceOf(SubjectKeyExistsError);
      await expect(
        db.unitOfWork.run(other, async () => ok(await service.createKey(other, subject))),
      ).rejects.toBeInstanceOf(SubjectKeyExistsError);
    });

    it('does not find the key from the other Market', async () => {
      const subject = await committedSubject();

      await expect(service.encrypt(other, subject, FIELD, 'x')).rejects.toBeInstanceOf(
        SubjectKeyMissingError,
      );
    });

    it('destroys idempotently, leaves a tombstone, and answers subject-key.destroyed', async () => {
      const subject = await committedSubject();
      const sealed = await service.encrypt(market, subject, FIELD, 'secret');
      if (!sealed.ok) throw new Error('expected ok');

      for (let attempt = 0; attempt < 2; attempt += 1) {
        await db.unitOfWork.run(market, async () => ok(await service.destroyKey(market, subject)));
      }

      expect(await rowOf(subject)).toMatchObject({
        wrapped_key: null,
        destroyed_at: new Date('2026-10-07T00:00:00.000Z'),
      });
      await expect(service.decrypt(market, subject, FIELD, sealed.value)).resolves.toEqual({
        ok: false,
        error: { code: 'subject-key.destroyed' },
      });
      await expect(
        db.unitOfWork.run(market, async () => ok(await service.createKey(market, subject))),
      ).rejects.toBeInstanceOf(SubjectKeyExistsError);
    });

    it('throws for a subject without a key on destroy', async () => {
      await expect(
        db.unitOfWork.run(market, async () => ok(await service.destroyKey(market, ids.next()))),
      ).rejects.toBeInstanceOf(SubjectKeyMissingError);
    });

    it('keeps the tombstone one-way and the identity columns frozen, for the owner too', async () => {
      const destroyed = await committedSubject();
      await db.unitOfWork.run(market, async () => ok(await service.destroyKey(market, destroyed)));
      const live = await committedSubject();

      await expect(
        owner.query(
          `UPDATE platform.subject_keys SET wrapped_key = 'lw1.revived', destroyed_at = NULL
            WHERE subject_id = $1`,
          [destroyed],
        ),
      ).rejects.toMatchObject({ code: '23001' });
      await expect(
        owner.query(`UPDATE platform.subject_keys SET market_id = $2 WHERE subject_id = $1`, [
          live,
          other.marketId,
        ]),
      ).rejects.toMatchObject({ code: '23001' });
      await expect(
        owner.query(`UPDATE platform.subject_keys SET key_version = 2 WHERE subject_id = $1`, [
          live,
        ]),
      ).rejects.toMatchObject({ code: '23001' });
    });

    it('refuses the application role a DELETE and an update of an identity column', async () => {
      const subject = await committedSubject();

      await expect(
        app.query('DELETE FROM platform.subject_keys WHERE subject_id = $1', [subject]),
      ).rejects.toMatchObject({ code: '42501' });
      await expect(
        app.query('UPDATE platform.subject_keys SET key_version = 2 WHERE subject_id = $1', [
          subject,
        ]),
      ).rejects.toMatchObject({ code: '42501' });
      expect(await rowOf(subject)).toBeDefined();
    });
  });
});
