import { auditField, defineAuditAction, describeAuditAction } from '@mondapac-drive/shared-kernel';
import type { AuditActionDefinition } from '@mondapac-drive/shared-kernel';
import {
  AuditActionCatalogue,
  AuditActionCatalogueError,
  compareAuditCatalogueWithSnapshot,
  registerAuditActions,
} from './audit-action-catalogue';

const seeded = defineAuditAction({
  action: 'identity.role.seeded',
  targetType: 'identity.role',
  actors: ['system'],
  after: { seedVersion: auditField.integer() },
});
const founded = defineAuditAction({
  action: 'identity.seller-access.founded',
  targetType: 'identity.seller-access',
  actors: ['anonymous'],
  after: {
    sellerId: auditField.id(),
    accountId: auditField.id(),
    boundSubjectId: auditField.id(),
    state: auditField.enumOf(['active'] as const),
  },
});
const viewed = defineAuditAction({
  action: 'platform.audit-log.viewed',
  targetType: 'platform.audit-log.market',
  actors: ['authenticated'],
});

describe('AuditActionCatalogue (platform-audit.md 3.2)', () => {
  it('registers a module and a platform component, and sorts its snapshot by action', () => {
    const catalogue = new AuditActionCatalogue();
    catalogue.register('identity', [seeded, founded]);
    catalogue.register('platform.audit-log', [viewed]);

    expect(catalogue.get('identity.role.seeded')).toBe(seeded);
    expect(catalogue.snapshot().map((entry) => entry.action)).toEqual([
      'identity.role.seeded',
      'identity.seller-access.founded',
      'platform.audit-log.viewed',
    ]);
  });

  it.each<[string, string, readonly unknown[]]>([
    ['a foreign first segment', 'sellers', [seeded]],
    ['a platform action under the bare platform owner', 'platform', [viewed]],
    ['a platform action under another component', 'platform.ai', [viewed]],
    ['a module action under a platform component', 'platform.identity', [seeded]],
    ['a malformed owner', 'Identity', [seeded]],
    ['an object literal shaped like a definition', 'identity', [{ ...seeded }]],
  ])('fails boot on %s', (_case, owner, definitions) => {
    const catalogue = new AuditActionCatalogue();

    expect(() =>
      catalogue.register(owner, definitions as readonly AuditActionDefinition[]),
    ).toThrow(AuditActionCatalogueError);
    expect(catalogue.snapshot()).toEqual([]);
  });

  it('fails boot on a duplicate action, within one call or across two', () => {
    const catalogue = new AuditActionCatalogue();

    expect(() => catalogue.register('identity', [seeded, seeded])).toThrow(/registered twice/);
    expect(() => catalogue.register('identity', [seeded])).toThrow(/registered twice/);
  });

  it('is sealed after bootstrap and refuses registrations then', () => {
    const catalogue = new AuditActionCatalogue();
    expect(catalogue.sealed).toBe(false);

    catalogue.onApplicationBootstrap();

    expect(catalogue.sealed).toBe(true);
    expect(() => catalogue.register('identity', [seeded])).toThrow(/sealed/);
  });

  it('registers through the one-line provider of a Nest module', () => {
    const catalogue = new AuditActionCatalogue();
    const provider = registerAuditActions('identity', [seeded]) as {
      useFactory: (catalogue: AuditActionCatalogue) => unknown;
    };

    provider.useFactory(catalogue);

    expect(catalogue.get('identity.role.seeded')).toBe(seeded);
  });
});

describe('compareAuditCatalogueWithSnapshot', () => {
  const current = [seeded, founded].map(describeAuditAction);

  it('agrees with an identical snapshot, whatever its key order', () => {
    const reordered = JSON.parse(
      JSON.stringify(current.map((entry) => Object.fromEntries(Object.entries(entry).reverse()))),
    ) as typeof current;

    expect(compareAuditCatalogueWithSnapshot(current, reordered)).toEqual([]);
  });

  it('reports a new, a changed and a removed action, each for security review', () => {
    const changed = { ...current[1]!, actors: ['anonymous', 'authenticated'] as const };
    const removed = describeAuditAction(viewed);

    expect(compareAuditCatalogueWithSnapshot(current, [changed, removed])).toEqual([
      'identity.role.seeded is new: add it to the snapshot, for security review',
      'identity.seller-access.founded changed its shape: update the snapshot, for security review',
      'platform.audit-log.viewed is in the snapshot but not registered',
    ]);
  });

  it('sees a changed list maximum as a change', () => {
    const keys = (max: number) =>
      describeAuditAction(
        defineAuditAction({
          action: 'identity.role.seed-applied',
          targetType: 'identity.role',
          actors: ['system'],
          after: { addedKeys: auditField.listOf(auditField.permissionKey(), max) },
        }),
      );

    expect(compareAuditCatalogueWithSnapshot([keys(64)], [keys(32)])).toHaveLength(1);
  });
});
