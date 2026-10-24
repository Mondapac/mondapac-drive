import {
  auditField,
  defineAuditAction,
  money,
  parseCorrelationId,
  Temporal,
} from '@mondapac-drive/shared-kernel';
import type {
  AuditEntry,
  CallContext,
  Clock,
  Id,
  MarketContext,
} from '@mondapac-drive/shared-kernel';
import {
  FixedClock,
  SequenceIdGenerator,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac-drive/shared-kernel/testing';
import { AuditActionCatalogue } from '../../audit/audit-action-catalogue';
import {
  AuditWriteRefusedError,
  MAX_AUDIT_SIDE_BYTES,
  type AuditRefusal,
  type AuditWriter,
} from '../../audit/audit-writer';
import { NO_PERMISSION_KEYS, type PermissionKeyLookup } from '../../events/outbox-writer';
import { PLATFORM_TENANT_ID } from '../../market-context/tenant';
import { OpenUnit, unitStorage } from '../unit-store';
import { createAuditWriter } from './prisma-audit-writer';

// The kernel as it is, with its correlation-id parser wrapped so one test can make it refuse.
jest.mock('@mondapac-drive/shared-kernel', () => {
  const actual = jest.requireActual<Record<string, unknown>>('@mondapac-drive/shared-kernel');
  return { ...actual, parseCorrelationId: jest.fn(actual.parseCorrelationId as () => unknown) };
});

// The writer of docs/design/domain/platform-audit.md 3.1 without a database: the open unit is
// a fake whose `auditLog.create` records the row. Every case runs for both Market fixtures.

const MARKETS = ['AU', 'ZZ'] as const;
const ACCOUNT = '01890a5d-ac96-774b-bcce-b302099a8057' as Id<'Account'>;
const SESSION = '01890a5d-ac96-774b-bcce-b302099a8058' as Id<'Session'>;
const ROLE = '01890a5d-ac96-774b-bcce-b302099a8059' as Id;
const TARGET = '01890a5d-ac96-774b-bcce-b302099a805a' as Id;
const START = Temporal.Instant.from('2026-10-08T09:30:00.123Z');
const KEYS: PermissionKeyLookup = {
  isKnownPermissionKey: (key) => key.startsWith('identity.') && key.endsWith('.view'),
};

const roleAssigned = defineAuditAction({
  action: 'identity.account-role.assigned',
  targetType: 'identity.account',
  actors: ['authenticated', 'system'],
  before: { roleId: auditField.optional(auditField.id()) },
  after: { roleId: auditField.id() },
});
const invitationAccepted = defineAuditAction({
  action: 'identity.invitation.accepted',
  targetType: 'identity.invitation',
  actors: ['anonymous'],
  after: { boundSubjectId: auditField.id() },
});
const seedApplied = defineAuditAction({
  action: 'identity.role.seed-applied',
  targetType: 'identity.role',
  actors: ['system'],
  after: {
    seedVersion: auditField.integer(),
    addedKeys: auditField.listOf(auditField.permissionKey(), 3),
  },
});
const settingChanged = defineAuditAction({
  action: 'identity.market-setting.changed',
  targetType: 'identity.market-setting',
  targetId: auditField.enumOf(['second-factor', 'sign-up'] as const),
  actors: ['authenticated'],
  before: { enabled: auditField.boolean() },
  after: { enabled: auditField.boolean() },
});
const bulkChanged = defineAuditAction({
  action: 'identity.role.bulk-changed',
  targetType: 'identity.role',
  actors: ['system'],
  after: { roleIds: auditField.listOf(auditField.id(), 200) },
});
const bulkPriced = defineAuditAction({
  action: 'identity.role.bulk-priced',
  targetType: 'identity.role',
  actors: ['system'],
  after: { amounts: auditField.listOf(auditField.money(), 100) },
});
const roleListed = defineAuditAction({
  action: 'identity.role.listed',
  targetType: 'identity.role',
  actors: ['system'],
});
const unregistered = defineAuditAction({
  action: 'identity.role.unregistered',
  targetType: 'identity.role',
  actors: ['system'],
});
const sellersViewed = defineAuditAction({
  action: 'sellers.business-details.viewed',
  targetType: 'sellers.seller',
  actors: ['authenticated'],
});

function sealedCatalogue(): AuditActionCatalogue {
  const catalogue = new AuditActionCatalogue();
  catalogue.register('identity', [
    roleAssigned,
    invitationAccepted,
    seedApplied,
    settingChanged,
    bulkChanged,
    bulkPriced,
    roleListed,
  ]);
  catalogue.register('sellers', [sellersViewed]);
  catalogue.seal();
  return catalogue;
}

interface Harness {
  readonly writer: AuditWriter;
  readonly rows: Record<string, unknown>[];
  /** Runs `work` inside an open unit of `market` (read-write unless `readOnly`). */
  readonly inUnit: <T>(
    market: MarketContext,
    work: () => Promise<T>,
    readOnly?: boolean,
  ) => Promise<T>;
}

function harness(
  options: {
    clock?: Clock;
    catalogue?: AuditActionCatalogue;
    owner?: string;
    keys?: PermissionKeyLookup;
  } = {},
): Harness {
  const clock = options.clock ?? new FixedClock(START);
  const rows: Record<string, unknown>[] = [];
  // The module view (what `PrismaService.tx` hands out) must never be used by the writer.
  const moduleView = {
    auditLog: {
      create: () => Promise.reject(new Error('the writer used the module view')),
    },
  };
  const view = {
    auditLog: {
      create: ({ data }: { data: Record<string, unknown> }) => {
        rows.push(data);
        return Promise.resolve(data);
      },
    },
  };
  const writer = createAuditWriter(options.owner ?? 'identity', {
    catalogue: options.catalogue ?? sealedCatalogue(),
    ids: new SequenceIdGenerator(clock),
    clock,
    permissionKeys: options.keys ?? KEYS,
  });
  return {
    writer,
    rows,
    inUnit: (market, work, readOnly = false) =>
      unitStorage.run(new OpenUnit(market, readOnly, moduleView, view), work),
  };
}

const marketOf = (code: string) => testMarketContext(code, PLATFORM_TENANT_ID);
const adminContext = (market: MarketContext): CallContext =>
  testCallContext(
    market,
    testAuthenticatedActor(market, {
      population: 'admin',
      accountId: ACCOUNT,
      sessionId: SESSION,
      merchantId: null,
    }),
    'request-correlation-0042',
  );

async function refusalOf(promise: Promise<unknown>): Promise<[AuditRefusal, string | null]> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AuditWriteRefusedError) return [error.reason, error.field];
    throw error;
  }
  throw new Error('expected a refusal');
}

describe.each(MARKETS)('the audit writer in market %s (platform-audit.md 3.1)', (code) => {
  const market = marketOf(code);

  describe('W2, W3: what the writer stamps', () => {
    it('writes an authenticated actor as USER with the account id, and the context stamps', async () => {
      const { writer, rows, inUnit } = harness();
      const entry = roleAssigned.entry(TARGET, {
        before: { roleId: null },
        after: { roleId: ROLE },
      });

      await inUnit(market, () => writer.record(adminContext(market), entry));

      expect(rows).toEqual([
        {
          id: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-7/) as string,
          marketId: code,
          tenantId: PLATFORM_TENANT_ID,
          occurredAt: new Date('2026-10-08T09:30:00.123Z'),
          actorType: 'USER',
          actorId: ACCOUNT,
          actingAsId: null,
          action: 'identity.account-role.assigned',
          targetType: 'identity.account',
          targetId: TARGET,
          before: { roleId: null },
          after: { roleId: ROLE },
          correlationId: 'request-correlation-0042',
        },
      ]);
    });

    it('writes a system actor as SYSTEM with no actor id, and leaves an undeclared side out', async () => {
      const { writer, rows, inUnit } = harness();
      const entry = seedApplied.entry(TARGET, {
        after: { seedVersion: 2, addedKeys: ['identity.role.view'] },
      });

      await inUnit(market, () => writer.record(testCallContext(market, 'system'), entry));

      expect(rows[0]).toMatchObject({ actorType: 'SYSTEM', actorId: null, actingAsId: null });
      expect(rows[0]).not.toHaveProperty('before');
      expect(rows[0]!.after).toEqual({ seedVersion: 2, addedKeys: ['identity.role.view'] });
    });

    it('writes an anonymous actor as ANONYMOUS, naming the bound subject (W4a)', async () => {
      const { writer, rows, inUnit } = harness();
      const entry = invitationAccepted.entry(TARGET, { after: { boundSubjectId: ACCOUNT } });

      await inUnit(market, () => writer.record(testCallContext(market, 'anonymous'), entry));

      expect(rows[0]).toMatchObject({
        actorType: 'ANONYMOUS',
        actorId: null,
        after: { boundSubjectId: ACCOUNT },
      });
    });

    it('cuts the clock to whole milliseconds (W3)', async () => {
      const clock: Clock = {
        now: () => Temporal.Instant.fromEpochNanoseconds(1_791_451_800_123_456_789n),
      };
      const { writer, rows, inUnit } = harness({ clock });

      await inUnit(market, () =>
        writer.record(
          testCallContext(market, 'system'),
          seedApplied.entry(TARGET, { after: { seedVersion: 1, addedKeys: [] } }),
        ),
      );

      expect((rows[0]!.occurredAt as Date).getTime()).toBe(1_791_451_800_123);
    });

    it('reads the clock at record time, not when the entry was built', async () => {
      const clock = new FixedClock(START);
      const { writer, rows, inUnit } = harness({ clock });
      const entry = seedApplied.entry(TARGET, { after: { seedVersion: 1, addedKeys: [] } });
      clock.advance(Temporal.Duration.from({ seconds: 5 }));

      await inUnit(market, () => writer.record(testCallContext(market, 'system'), entry));

      expect(rows[0]!.occurredAt).toEqual(new Date('2026-10-08T09:30:05.123Z'));
    });

    it('takes a natural key of the declared enumOf as the target id', async () => {
      const { writer, rows, inUnit } = harness();
      const entry = settingChanged.entry('sign-up', {
        before: { enabled: false },
        after: { enabled: true },
      });

      await inUnit(market, () => writer.record(adminContext(market), entry));

      expect(rows[0]).toMatchObject({ targetId: 'sign-up', targetType: 'identity.market-setting' });
    });

    it('accepts several rows in one unit (W6)', async () => {
      const { writer, rows, inUnit } = harness();
      const context = testCallContext(market, 'system');

      await inUnit(market, async () => {
        await writer.record(
          context,
          seedApplied.entry(TARGET, { after: { seedVersion: 1, addedKeys: [] } }),
        );
        await writer.record(
          context,
          roleAssigned.entry(TARGET, {
            before: { roleId: null },
            after: { roleId: ROLE },
          }),
        );
      });

      expect(rows.map((row) => row.action)).toEqual([
        'identity.role.seed-applied',
        'identity.account-role.assigned',
      ]);
      expect(new Set(rows.map((row) => row.id)).size).toBe(2);
    });
  });

  describe('W1, W4, W4a, W5: every refusal throws, and nothing is written', () => {
    const system = () => testCallContext(market, 'system');
    const seed = (after: Record<string, unknown>) =>
      ({
        ...seedApplied.entry(TARGET, { after: { seedVersion: 1, addedKeys: [] } }),
        after,
      }) as AuditEntry;

    it.each<[string, (h: Harness) => Promise<unknown>, AuditRefusal, string | null]>([
      [
        'a context that was not minted',
        (h) =>
          h.inUnit(market, () =>
            h.writer.record(
              { ...system() },
              seedApplied.entry(TARGET, { after: { seedVersion: 1, addedKeys: [] } }),
            ),
          ),
        'context-not-minted',
        null,
      ],
      [
        'no open unit',
        (h) =>
          h.writer.record(
            system(),
            seedApplied.entry(TARGET, { after: { seedVersion: 1, addedKeys: [] } }),
          ),
        'no-open-unit',
        null,
      ],
      [
        'a read-only unit',
        (h) =>
          h.inUnit(
            market,
            () =>
              h.writer.record(
                system(),
                seedApplied.entry(TARGET, { after: { seedVersion: 1, addedKeys: [] } }),
              ),
            true,
          ),
        'read-only-unit',
        null,
      ],
      [
        "another Market's unit",
        (h) =>
          h.inUnit(marketOf(code === 'AU' ? 'ZZ' : 'AU'), () =>
            h.writer.record(
              system(),
              seedApplied.entry(TARGET, { after: { seedVersion: 1, addedKeys: [] } }),
            ),
          ),
        'market-mismatch',
        null,
      ],
      [
        'an entry that is not an object',
        (h) =>
          h.inUnit(market, () =>
            h.writer.record(system(), 'identity.role.seed-applied' as unknown as AuditEntry),
          ),
        'entry-invalid',
        null,
      ],
      [
        "another owner's action",
        (h) =>
          h.inUnit(market, () =>
            h.writer.record(adminContext(market), sellersViewed.entry(TARGET, {})),
          ),
        'action-of-another-owner',
        null,
      ],
      [
        'an action of its own prefix missing from the catalogue',
        (h) => h.inUnit(market, () => h.writer.record(system(), unregistered.entry(TARGET, {}))),
        'action-not-in-catalogue',
        null,
      ],
      [
        'a target type other than the definition',
        (h) =>
          h.inUnit(market, () =>
            h.writer.record(system(), {
              ...seedApplied.entry(TARGET, { after: { seedVersion: 1, addedKeys: [] } }),
              targetType: 'identity.account',
            }),
          ),
        'target-type-mismatch',
        null,
      ],
      [
        'a malformed id target',
        (h) =>
          h.inUnit(market, () =>
            h.writer.record(
              system(),
              seedApplied.entry('not-an-id' as Id, { after: { seedVersion: 1, addedKeys: [] } }),
            ),
          ),
        'target-id-invalid',
        null,
      ],
      [
        'a target outside the declared enumOf',
        (h) =>
          h.inUnit(market, () =>
            h.writer.record(adminContext(market), {
              ...settingChanged.entry('sign-up', {
                before: { enabled: true },
                after: { enabled: false },
              }),
              targetId: 'other',
            }),
          ),
        'target-id-invalid',
        null,
      ],
      [
        'an actor kind the action does not allow',
        (h) =>
          h.inUnit(market, () =>
            h.writer.record(
              adminContext(market),
              seedApplied.entry(TARGET, { after: { seedVersion: 1, addedKeys: [] } }),
            ),
          ),
        'actor-not-allowed',
        null,
      ],
      [
        'a before side the action does not declare',
        (h) =>
          h.inUnit(market, () =>
            h.writer.record(system(), {
              ...seedApplied.entry(TARGET, { after: { seedVersion: 1, addedKeys: [] } }),
              before: { seedVersion: 0 },
            }),
          ),
        'before-undeclared',
        null,
      ],
      [
        'an after side the action does not declare',
        (h) =>
          h.inUnit(market, () =>
            h.writer.record(system(), { ...roleListed.entry(TARGET, {}), after: { count: 1 } }),
          ),
        'after-undeclared',
        null,
      ],
      [
        'an undeclared field, without naming it',
        (h) =>
          h.inUnit(market, () =>
            h.writer.record(
              system(),
              seed({ seedVersion: 1, addedKeys: [], email: 'x@example.test' }),
            ),
          ),
        'after-invalid',
        null,
      ],
      [
        'a missing declared field',
        (h) => h.inUnit(market, () => h.writer.record(system(), seed({ addedKeys: [] }))),
        'after-invalid',
        'seedVersion',
      ],
      [
        'free text in a declared field',
        (h) =>
          h.inUnit(market, () =>
            h.writer.record(system(), seed({ seedVersion: 'two', addedKeys: [] })),
          ),
        'after-invalid',
        'seedVersion',
      ],
      [
        'a permission key the lookup does not know',
        (h) =>
          h.inUnit(market, () =>
            h.writer.record(system(), seed({ seedVersion: 1, addedKeys: ['identity.role.edit'] })),
          ),
        'after-invalid',
        'addedKeys',
      ],
      [
        'a list longer than its maximum',
        (h) =>
          h.inUnit(market, () =>
            h.writer.record(
              system(),
              seed({
                seedVersion: 1,
                addedKeys: [
                  'identity.a.view',
                  'identity.b.view',
                  'identity.c.view',
                  'identity.d.view',
                ],
              }),
            ),
          ),
        'list-too-long',
        'addedKeys',
      ],
      [
        'a before side that does not match its fields',
        (h) =>
          h.inUnit(market, () =>
            h.writer.record(adminContext(market), {
              ...settingChanged.entry('sign-up', {
                before: { enabled: true },
                after: { enabled: false },
              }),
              before: { enabled: 'yes' },
            }),
          ),
        'before-invalid',
        'enabled',
      ],
      [
        'an after side over 4 KB of canonical JSON',
        (h) =>
          h.inUnit(market, () =>
            h.writer.record(
              system(),
              bulkChanged.entry(TARGET, {
                after: { roleIds: Array.from({ length: 200 }, () => ROLE) },
              }),
            ),
          ),
        'after-too-large',
        null,
      ],
      [
        'a money list over its maximum',
        (h) =>
          h.inUnit(market, () =>
            h.writer.record(
              system(),
              bulkPriced.entry(TARGET, {
                after: { amounts: Array.from({ length: 101 }, () => money(1n, 'AUD')) },
              }),
            ),
          ),
        'list-too-long',
        'amounts',
      ],
      [
        'an after side of money items over 4 KB of canonical JSON',
        (h) =>
          h.inUnit(market, () =>
            h.writer.record(
              system(),
              bulkPriced.entry(TARGET, {
                after: {
                  amounts: Array.from({ length: 100 }, () => money(9_999_999_999_999_999n, 'AUD')),
                },
              }),
            ),
          ),
        'after-too-large',
        null,
      ],
      [
        'an anonymous entry without boundSubjectId (W4a)',
        (h) =>
          h.inUnit(market, () =>
            h.writer.record(testCallContext(market, 'anonymous'), {
              ...invitationAccepted.entry(TARGET, { after: { boundSubjectId: ACCOUNT } }),
              after: {},
            }),
          ),
        'after-invalid',
        'boundSubjectId',
      ],
    ])('refuses %s', async (_case, attempt, reason, field) => {
      const h = harness();

      await expect(refusalOf(attempt(h))).resolves.toEqual([reason, field]);
      expect(h.rows).toEqual([]);
    });

    it('refuses an anonymous row without boundSubjectId even if a definition let it through (W4a)', async () => {
      // defineAuditAction and the catalogue refuse such a definition at boot; the writer checks
      // again, so a definition forged past both still cannot write an unbound anonymous row.
      const catalogue = sealedCatalogue();
      const forged = { ...roleAssigned, actors: ['anonymous', 'authenticated', 'system'] };
      jest.spyOn(catalogue, 'get').mockReturnValue(forged as unknown as typeof roleAssigned);
      const h = harness({ catalogue });

      await expect(
        refusalOf(
          h.inUnit(market, () =>
            h.writer.record(
              testCallContext(market, 'anonymous'),
              roleAssigned.entry(TARGET, { before: { roleId: null }, after: { roleId: ROLE } }),
            ),
          ),
        ),
      ).resolves.toEqual(['bound-subject-missing', null]);
      expect(h.rows).toEqual([]);
    });

    it('refuses before the catalogue is sealed', async () => {
      const catalogue = new AuditActionCatalogue();
      catalogue.register('identity', [seedApplied]);
      const h = harness({ catalogue });

      await expect(
        refusalOf(
          h.inUnit(market, () =>
            h.writer.record(
              system(),
              seedApplied.entry(TARGET, { after: { seedVersion: 1, addedKeys: [] } }),
            ),
          ),
        ),
      ).resolves.toEqual(['catalogue-not-sealed', null]);
    });

    it('refuses every permission key under the fail-closed lookup (NO_PERMISSION_KEYS, tests only since 8a-1)', async () => {
      const h = harness({ keys: NO_PERMISSION_KEYS });

      await expect(
        refusalOf(
          h.inUnit(market, () =>
            h.writer.record(system(), seed({ seedVersion: 1, addedKeys: ['identity.role.view'] })),
          ),
        ),
      ).resolves.toEqual(['after-invalid', 'addedKeys']);
    });

    it.each(['after', 'before'] as const)(
      'accepts %s of exactly 4 KB of canonical JSON and refuses one byte more',
      async (side) => {
        const fields = {
          ids: auditField.listOf(auditField.id(), 256),
          extra: auditField.integer(),
          more: auditField.integer(),
        };
        const sized = defineAuditAction({
          action: 'identity.role.sized',
          targetType: 'identity.role',
          actors: ['system'],
          before: fields,
          after: fields,
        });
        const catalogue = new AuditActionCatalogue();
        catalogue.register('identity', [sized]);
        catalogue.seal();
        // {"extra":N,"ids":[...],"more":0} in canonical order: 104 ids (39 bytes each with the
        // comma) leave room for a 13-digit N.
        const ids = Array.from({ length: 104 }, () => ROLE);
        const fill = MAX_AUDIT_SIDE_BYTES - JSON.stringify({ extra: 0, ids, more: 0 }).length;
        const exact = 10 ** fill;
        const small = { ids: [ROLE], extra: 0, more: 0 };
        const entryWith = (extra: number) => {
          const big = { ids, extra, more: 0 };
          return sized.entry(TARGET, {
            before: side === 'before' ? big : small,
            after: side === 'after' ? big : small,
          });
        };
        const h = harness({ catalogue });

        expect(JSON.stringify({ extra: exact, ids, more: 0 })).toHaveLength(MAX_AUDIT_SIDE_BYTES);
        expect(Number.isSafeInteger(exact * 10)).toBe(true);
        await h.inUnit(market, () => h.writer.record(system(), entryWith(exact)));
        await expect(
          refusalOf(h.inUnit(market, () => h.writer.record(system(), entryWith(exact * 10)))),
        ).resolves.toEqual([side === 'before' ? 'before-too-large' : 'after-too-large', null]);
        expect(h.rows).toHaveLength(1);
      },
    );

    it('refuses a context whose correlation id does not parse (Sajad L1)', async () => {
      // A minted context always holds a parsed id; the writer checks it again (defence in
      // depth), so the kernel's parser is made to refuse it once here.
      jest
        .mocked(parseCorrelationId)
        .mockReturnValueOnce({ ok: false, error: { code: 'correlation-id.invalid' } });
      const h = harness();

      await expect(
        refusalOf(
          h.inUnit(market, () =>
            h.writer.record(
              system(),
              seedApplied.entry(TARGET, { after: { seedVersion: 1, addedKeys: [] } }),
            ),
          ),
        ),
      ).resolves.toEqual(['correlation-id-invalid', null]);
      expect(h.rows).toEqual([]);
    });

    it('carries no value in its message', async () => {
      const h = harness();
      const error = await h
        .inUnit(market, () =>
          h.writer.record(system(), seed({ seedVersion: 1, addedKeys: [], secret: 'p@ss' })),
        )
        .catch((caught: unknown) => caught as Error);

      expect(error).toBeInstanceOf(AuditWriteRefusedError);
      expect((error as Error).message).not.toContain('p@ss');
      expect((error as Error).message).not.toContain('secret');
    });
  });
});
