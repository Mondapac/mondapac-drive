import { readdirSync, readFileSync } from 'node:fs';
import { devNull } from 'node:os';
import path from 'node:path';
import { Module, type INestApplicationContext, type Provider } from '@nestjs/common';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { Test } from '@nestjs/testing';
import { auditField, defineAuditAction } from '@mondapac-drive/shared-kernel';
import type {
  AuditActionDefinition,
  AuditActionDescription,
  AuditFieldKind,
} from '@mondapac-drive/shared-kernel';
import pino from 'pino';
import { AppModule } from '../../src/app.module';
import { CORE_MODULES } from '../../src/modules';
import {
  AuditActionCatalogue,
  compareAuditCatalogueWithSnapshot,
} from '../../src/platform/audit/audit-action-catalogue';
import { AUDIT_WRITER } from '../../src/platform/audit/audit-writer';
import { PersistenceModule } from '../../src/platform/persistence/persistence.module';
import { testAppConfig } from '../support/test-config';

// The contracts tests of docs/design/domain/platform-audit.md 16 (identity slices 6a and 6b):
// - the audit action catalogue of the booted application, in both roles, equals the checked-in
//   snapshot, so every new or changed action is read by the security-tester in the diff (3.2);
// - Ali's condition 1 on the 6a/6b split, as 6b changes it: only the modules of AUDITING_MODULES
//   bind an AUDIT_WRITER provider, each its own (identity since 6b; pricing since its slice 1
//   part 3b, whose audited actions are design 8 of its approved G2; sellers since slice 7a-read,
//   design 9);
// - Hassan L4 (carried from 6a): each registration of actions and each writer binding names the
//   folder it is declared in: `<m>` only in src/modules/<m>/<m>.module.ts, and
//   `platform.<component>` only in src/platform/<component>/. Checked in the source and in the
//   booted graph, for `registerAuditActions` and `auditWriterFor` alike;
// - a module can reach neither another module's writer nor a writer factory (PA 2);
// - Cost never enters the audit log (ADR-0024; pricing design 21, condition (h); Hassan H2, M1):
//   a `money` field must be on a checked-in allow-list; no `money` or `integer` field (bare,
//   optional or listOf, before or after) on a `pricing.` action with a `cost` name segment; no
//   `money` or `integer` field named like a cost (`/cost/i`) in any module.

const SNAPSHOT = path.join(__dirname, 'audit-action-catalogue.snapshot.json');

/**
 * The Nest modules that bind their own audit writer and register their actions. A module joins
 * this list only with the audited actions its approved design names: fleet (work package 05)
 * with its operator decisions on couriers and documents; identity with its access-management
 * actions (accounts, roles, sessions, merchants and API keys); dispatch (handoff 22) with a
 * dispatcher's assignments and restarts.
 */
const AUDITING_MODULES: readonly string[] = ['DispatchModule', 'FleetModule', 'IdentityModule'];
const SRC = path.join(__dirname, '../../src');

const foldersOf = (dir: string) =>
  readdirSync(path.join(SRC, dir), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
const MODULE_FOLDERS = foldersOf('modules');
const PLATFORM_FOLDERS = foldersOf('platform');

/**
 * The owner a Nest module may register actions and bind a writer for: its module folder
 * (`IdentityModule` is `identity`), or `platform.<component>` for the Nest module of
 * src/platform/<component>/ (`AuditModule` is `platform.audit`); null for any other.
 */
function ownerOfNestModule(name: string): string | null {
  const lower = name.toLowerCase();
  const named = (folder: string) => `${folder.replaceAll('-', '')}module` === lower;
  const module = MODULE_FOLDERS.find(named);
  if (module !== undefined) return module;
  const component = PLATFORM_FOLDERS.find(named);
  return component === undefined ? null : `platform.${component}`;
}

/** The owner a source file may name: `<m>` in modules/<m>/<m>.module.ts, `platform.<c>` in platform/<c>/. */
function ownerOfFile(file: string): string | null {
  const [top, folder, name] = file.split(path.sep);
  if (top === 'modules' && folder !== undefined && name === `${folder}.module.ts`) return folder;
  if (top === 'platform' && folder !== undefined && name !== undefined) return `platform.${folder}`;
  return null;
}

function apiGraph() {
  return Test.createTestingModule({
    imports: [
      AppModule.register({
        config: testAppConfig({ APP_ROLE: 'api' }),
        logDestination: pino.destination(devNull),
      }),
    ],
  }).compile();
}

async function boot(role: 'api' | 'worker'): Promise<INestApplicationContext> {
  const moduleRef = await Test.createTestingModule({
    imports: [
      AppModule.register({
        config: testAppConfig({ APP_ROLE: role }),
        logDestination: pino.destination(devNull),
      }),
    ],
  }).compile();
  return moduleRef.init();
}

interface NestModuleView {
  readonly metatype: { readonly name: string };
  readonly providers: Map<unknown, { readonly instance: unknown }>;
  readonly exports: Set<unknown>;
}

/** The Nest modules of a compiled graph, with their provider wrappers. */
function nestModulesOf(moduleRef: unknown): NestModuleView[] {
  const container = (moduleRef as { container: { getModules(): Map<string, NestModuleView> } })
    .container;
  return [...container.getModules().values()];
}

/** The kind a `listOf` or `optional` wraps, or the kind itself. */
const plainKindOf = (kind: AuditFieldKind): AuditFieldKind['kind'] =>
  kind.kind === 'listOf' || kind.kind === 'optional' ? kind.of.kind : kind.kind;

/** True for a `money` kind, or a `listOf` or `optional` of one. */
const isMoneyKind = (kind: AuditFieldKind): boolean => plainKindOf(kind) === 'money';

/** True for a number-carrying kind: `money` or `integer`, bare or wrapped. */
const isAmountKind = (kind: AuditFieldKind): boolean =>
  isMoneyKind(kind) || plainKindOf(kind) === 'integer';

/**
 * The (action, field) pairs that may declare `money`, as `<action>.<side>.<field>`. A new money
 * field anywhere fails the contract until it is added here in a reviewed change (Hassan M1;
 * platform-audit 3.2). Pricing's regular-price and special-price rows carry the seller's own amounts, and sellers' minimum-order change the seller's own public minimum; Cost
 * never enters an audit row (ADR-0024), which `costLeakProblems` checks apart from this list.
 */
const MONEY_FIELD_ALLOW_LIST: readonly string[] = [];

/** Every field of every action, as `<action>.<side>.<field>` with its kind. */
function auditFieldsOf(definitions: readonly AuditActionDefinition[]) {
  return definitions.flatMap((definition) =>
    (['before', 'after'] as const).flatMap((side) =>
      Object.entries(definition[side] ?? {}).map(([name, kind]) => ({
        action: definition.action,
        path: `${definition.action}.${side}.${name}`,
        name,
        kind,
      })),
    ),
  );
}

/**
 * The breaches of the Cost-leak contract (ADR-0024; Hassan H2, M1):
 * 1. a `money` field that is not on the allow-list;
 * 2. a `money` or `integer` field (bare, optional or listOf, before or after) on a `pricing.`
 *    action with a name segment starting `cost`;
 * 3. a `money` or `integer` field whose name contains `cost`, in any module.
 */
function costLeakProblems(
  definitions: readonly AuditActionDefinition[],
  allowList: readonly string[],
): string[] {
  return auditFieldsOf(definitions).flatMap((field) => {
    const problems: string[] = [];
    if (isMoneyKind(field.kind) && !allowList.includes(field.path)) {
      problems.push(`${field.path}: money field not on the allow-list`);
    }
    const segments = field.action.split(/[.-]/);
    if (
      field.action.startsWith('pricing.') &&
      segments.some((segment) => /^cost/.test(segment)) &&
      isAmountKind(field.kind)
    ) {
      problems.push(`${field.path}: amount field on a cost action`);
    }
    if (/cost/i.test(field.name) && isAmountKind(field.kind)) {
      problems.push(`${field.path}: amount field named like a cost`);
    }
    return problems;
  });
}

/** The owner a bound writer was built for (the writer keeps it to check each entry). */
const ownerOfWriter = (writer: unknown) => (writer as { owner?: unknown }).owner;

describe('audit action catalogue of the booted application (PA 3.2)', () => {
  const graphs = new Map<'api' | 'worker', INestApplicationContext>();

  beforeAll(async () => {
    for (const role of ['api', 'worker'] as const) graphs.set(role, await boot(role));
  });

  afterAll(async () => {
    for (const graph of graphs.values()) await graph.close();
  });

  it('matches the checked-in snapshot of every action and its shape', () => {
    const snapshot = JSON.parse(readFileSync(SNAPSHOT, 'utf8')) as AuditActionDescription[];
    const current = graphs.get('api')!.get(AuditActionCatalogue).snapshot();

    expect({ problems: compareAuditCatalogueWithSnapshot(current, snapshot), current }).toEqual({
      problems: [],
      current,
    });
  });

  it('is sealed once the application has bootstrapped, and the same in both roles', () => {
    const api = graphs.get('api')!.get(AuditActionCatalogue);
    const worker = graphs.get('worker')!.get(AuditActionCatalogue);

    expect(api.sealed).toBe(true);
    expect(worker.sealed).toBe(true);
    expect(worker.snapshot()).toEqual(api.snapshot());
  });

  it('declares no money field off the allow-list, and no amount on a cost action or field (ADR-0024, H2, M1)', () => {
    const catalogue = graphs.get('api')!.get(AuditActionCatalogue);
    const definitions = catalogue.snapshot().map((entry) => catalogue.get(entry.action)!);

    expect(costLeakProblems(definitions, MONEY_FIELD_ALLOW_LIST)).toEqual([]);
  });

  it('would catch each rule: allow-list, cost-named action, cost-named field, in every wrapping', () => {
    const define = (action: string, targetType: string, after: Record<string, AuditFieldKind>) =>
      defineAuditAction({ action, targetType, actors: ['authenticated'], after });
    const money = auditField.money();
    const integer = auditField.integer();
    const wrapped = (kind: typeof money | typeof integer) => ({
      bare: kind,
      maybe: auditField.optional(kind),
      many: auditField.listOf(kind, 4),
    });
    const costChanged = (after: Record<string, AuditFieldKind>) =>
      define('pricing.cost.changed', 'pricing.cost-record', after);

    // Rule 2: money and integer on a pricing action with a cost segment, before or after.
    expect(
      costLeakProblems(
        [costChanged(wrapped(money))],
        [
          'pricing.cost.changed.after.bare',
          'pricing.cost.changed.after.maybe',
          'pricing.cost.changed.after.many',
        ],
      ),
    ).toEqual([
      'pricing.cost.changed.after.bare: amount field on a cost action',
      'pricing.cost.changed.after.maybe: amount field on a cost action',
      'pricing.cost.changed.after.many: amount field on a cost action',
    ]);
    expect(costLeakProblems([costChanged(wrapped(integer))], [])).toEqual([
      'pricing.cost.changed.after.bare: amount field on a cost action',
      'pricing.cost.changed.after.maybe: amount field on a cost action',
      'pricing.cost.changed.after.many: amount field on a cost action',
    ]);
    expect(
      costLeakProblems(
        [
          defineAuditAction({
            action: 'pricing.margin.cost-updated',
            targetType: 'pricing.margin',
            actors: ['authenticated'],
            before: { steps: auditField.listOf(integer, 2) },
          }),
        ],
        [],
      ),
    ).toEqual(['pricing.margin.cost-updated.before.steps: amount field on a cost action']);

    // Rule 1: any money field outside the allow-list, until it is listed.
    const price = define('pricing.regular-price.accepted', 'pricing.price-record', {
      amount: money,
    });
    expect(costLeakProblems([price], [])).toEqual([
      'pricing.regular-price.accepted.after.amount: money field not on the allow-list',
    ]);
    expect(costLeakProblems([price], ['pricing.regular-price.accepted.after.amount'])).toEqual([]);

    // Rule 3: a field named like a cost, in any module, money or integer.
    const elsewhere = define('catalog.product.priced', 'catalog.product', {
      unitCost: integer,
      costBasis: auditField.optional(integer),
      total: integer,
    });
    expect(costLeakProblems([elsewhere], [])).toEqual([
      'catalog.product.priced.after.unitCost: amount field named like a cost',
      'catalog.product.priced.after.costBasis: amount field named like a cost',
    ]);
    const elsewhereMoney = define('catalog.product.repriced', 'catalog.product', {
      landedCostAmount: auditField.listOf(money, 2),
    });
    expect(
      costLeakProblems([elsewhereMoney], ['catalog.product.repriced.after.landedCostAmount']),
    ).toEqual(['catalog.product.repriced.after.landedCostAmount: amount field named like a cost']);

    // Fields that are not amounts, and ordinary integers, pass.
    expect(
      costLeakProblems(
        [costChanged({ recordId: auditField.id(), seen: auditField.boolean() })],
        [],
      ),
    ).toEqual([]);
  });

  it('names, for every action, an owner whose folder exists (Hassan L4)', () => {
    const catalogue = graphs.get('api')!.get(AuditActionCatalogue);
    const unknown = catalogue
      .snapshot()
      .map((entry) => catalogue.get(entry.action)!)
      .filter((definition) => {
        const platform = /^platform\.(.+)$/.exec(definition.owner);
        return platform === null
          ? !MODULE_FOLDERS.includes(definition.owner)
          : !PLATFORM_FOLDERS.includes(platform[1]!);
      })
      .map((definition) => definition.action);

    expect(unknown).toEqual([]);
  });
});

describe('only the auditing modules bind an audit writer, each its own (Ali, condition 1, as 6b changes it)', () => {
  /**
   * Every provider token of a Nest module and of the submodules it imports, depth first. An
   * imported bounded-context module (`sellers` imports `identity` for its facade) is its own
   * case, not a submodule, so the walk does not enter it.
   */
  function providerTokens(module: object, seen = new Set<object>()): unknown[] {
    if (seen.has(module)) return [];
    seen.add(module);
    const providers = (Reflect.getMetadata(MODULE_METADATA.PROVIDERS, module) ?? []) as Provider[];
    const imports = (Reflect.getMetadata(MODULE_METADATA.IMPORTS, module) ?? []) as unknown[];
    return [
      ...providers.map((provider) =>
        typeof provider === 'object' && 'provide' in provider ? provider.provide : provider,
      ),
      ...imports
        .filter((imported): imported is object => typeof imported === 'function')
        .filter((imported) => !(CORE_MODULES as readonly object[]).includes(imported))
        .flatMap((imported) => providerTokens(imported, seen)),
    ];
  }

  it('sees a binding when there is one, also in an imported submodule', () => {
    @Module({ providers: [PersistenceModule.auditWriterFor('alpha')] })
    class AlphaInfrastructureModule {}
    @Module({ imports: [AlphaInfrastructureModule] })
    class AlphaModule {}

    expect(providerTokens(AlphaModule)).toContain(AUDIT_WRITER);
  });

  it.each(CORE_MODULES.map((module) => [module.name, module] as const))(
    '%s provides an AUDIT_WRITER only if it is an auditing module',
    (name, module) => {
      expect(providerTokens(module).includes(AUDIT_WRITER)).toBe(AUDITING_MODULES.includes(name));
    },
  );

  it('in the booted graph, only the auditing modules resolve an AUDIT_WRITER, each bound to its own folder', async () => {
    const moduleRef = await apiGraph();
    const binders = nestModulesOf(moduleRef)
      .filter((nestModule) => nestModule.providers.has(AUDIT_WRITER))
      .map((nestModule) => [
        nestModule.metatype.name,
        ownerOfWriter(nestModule.providers.get(AUDIT_WRITER)!.instance),
      ]);
    await moduleRef.close();

    expect(binders.sort()).toEqual([
      ['DispatchModule', 'dispatch'],
      ['FleetModule', 'fleet'],
      ['IdentityModule', 'identity'],
    ]);
  });

  it('binds every writer and registers every action list in the Nest module of its owner (Hassan L4)', async () => {
    const moduleRef = await apiGraph();
    const found: { module: string; kind: string; owner: unknown; allowed: string | null }[] = [];
    for (const nestModule of nestModulesOf(moduleRef)) {
      const module = nestModule.metatype.name;
      const allowed = ownerOfNestModule(module);
      for (const [token, wrapper] of nestModule.providers) {
        if (typeof token === 'symbol' && token.description?.startsWith('audit-actions:') === true) {
          // registerAuditActions' provider answers the owner it registered.
          found.push({ module, kind: 'actions', owner: wrapper.instance, allowed });
        } else if (token === AUDIT_WRITER) {
          found.push({ module, kind: 'writer', owner: ownerOfWriter(wrapper.instance), allowed });
        }
      }
    }
    await moduleRef.close();

    expect(found.map((entry) => [entry.module, entry.kind]).sort()).toEqual([
      ['DispatchModule', 'actions'],
      ['DispatchModule', 'writer'],
      ['FleetModule', 'actions'],
      ['FleetModule', 'writer'],
      ['IdentityModule', 'actions'],
      ['IdentityModule', 'writer'],
    ]);
    expect(found.filter((entry) => entry.owner !== entry.allowed)).toEqual([]);
  });

  it('maps Nest modules to the owners they may name', () => {
    expect(ownerOfNestModule('DeliveryModule')).toBe('delivery');
    expect(ownerOfNestModule('AuditModule')).toBe('platform.audit');
    expect(ownerOfNestModule('AppModule')).toBeNull();
    expect(ownerOfFile(path.join('modules', 'identity', 'identity.module.ts'))).toBe('identity');
    expect(ownerOfFile(path.join('modules', 'identity', 'domain', 'audit', 'index.ts'))).toBeNull();
    expect(ownerOfFile(path.join('platform', 'ai', 'ai.module.ts'))).toBe('platform.ai');
    expect(ownerOfFile('app.module.ts')).toBeNull();
  });

  // The provider walks see only the tokens; a wrapping factory or a renamed token would slip
  // past them. So the source is scanned too (Hassan L4): outside their definitions,
  // `registerAuditActions('<owner>', ...)` and `PersistenceModule.auditWriterFor('<owner>')`
  // appear at most once per file, as a call with a literal owner that is the file's own
  // folder's, besides an import of the name. Nothing else names the writer's implementation.
  it('calls registerAuditActions and auditWriterFor only with the owner of the folder they are in (Hassan L4)', () => {
    const WRITER_DEFINITION = path.join('platform', 'persistence', 'persistence.module.ts');
    const ACTIONS_DEFINITION = path.join('platform', 'audit', 'audit-action-catalogue.ts');
    const IMPLEMENTATION = path.join('platform', 'persistence', 'audit', 'prisma-audit-writer.ts');
    const HELPERS = [
      {
        name: 'auditWriterFor',
        definition: WRITER_DEFINITION,
        call: /(?<![.\w])PersistenceModule\.auditWriterFor\('([^']*)'\)/g,
      },
      {
        name: 'registerAuditActions',
        definition: ACTIONS_DEFINITION,
        call: /(?<![.\w])registerAuditActions\('([^']*)',/g,
      },
    ];
    const offenders: string[] = [];
    const calls: string[] = [];

    for (const entry of readdirSync(SRC, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.ts') || entry.name.endsWith('.spec.ts')) {
        continue;
      }
      const file = path.relative(SRC, path.join(entry.parentPath, entry.name));
      if (file === IMPLEMENTATION) continue;
      // Comments may name the helpers (their own documentation does); code may not.
      const code = readFileSync(path.join(SRC, file), 'utf8')
        .replaceAll(/\/\*[\s\S]*?\*\//g, '')
        .replaceAll(/\/\/.*$/gm, '');
      if (file !== WRITER_DEFINITION && /prisma-audit-writer|createAuditWriter/.test(code)) {
        offenders.push(`${file}: names the writer's implementation`);
      }
      for (const helper of HELPERS) {
        if (file === helper.definition) continue;
        const uses = code.split(helper.name).length - 1;
        if (uses === 0) continue;
        const called = [...code.matchAll(helper.call)];
        const imported = new RegExp(`import\\s*\\{[^}]*\\b${helper.name}\\b[^}]*\\}\\s*from`).test(
          code,
        )
          ? 1
          : 0;
        if (called.length > 1 || called.length + imported !== uses) {
          offenders.push(
            `${file}: ${helper.name} is used other than as one call with a literal owner`,
          );
          continue;
        }
        for (const [, owner] of called) {
          calls.push(`${file}: ${helper.name}('${owner}')`);
          if (owner !== ownerOfFile(file)) {
            offenders.push(`${file}: ${helper.name}('${owner}') does not name its own folder`);
          }
        }
      }
    }

    expect(offenders).toEqual([]);
    expect(calls.sort()).toEqual([
      `${path.join('modules', 'dispatch', 'dispatch.module.ts')}: auditWriterFor('dispatch')`,
      `${path.join('modules', 'dispatch', 'dispatch.module.ts')}: registerAuditActions('dispatch')`,
      `${path.join('modules', 'fleet', 'fleet.module.ts')}: auditWriterFor('fleet')`,
      `${path.join('modules', 'fleet', 'fleet.module.ts')}: registerAuditActions('fleet')`,
      `${path.join('modules', 'identity', 'identity.module.ts')}: auditWriterFor('identity')`,
      `${path.join('modules', 'identity', 'identity.module.ts')}: registerAuditActions('identity')`,
    ]);
  });
});

describe('a module reaches only its own audit writer (PA 2)', () => {
  function compileWith(...extra: object[]): Promise<unknown> {
    return Test.createTestingModule({
      imports: [
        AppModule.register({
          config: testAppConfig({ APP_ROLE: 'api' }),
          logDestination: pino.destination(devNull),
        }),
        ...(extra as never[]),
      ],
    }).compile();
  }

  it('cannot resolve an AUDIT_WRITER it did not bind: no module exports one', async () => {
    @Module({ providers: [{ provide: 'ROGUE', inject: [AUDIT_WRITER], useFactory: () => 1 }] })
    class RogueModule {}

    await expect(compileWith(RogueModule)).rejects.toThrow(/can't resolve dependencies/i);
  });

  it("cannot resolve another module's writer, even once one module binds it", async () => {
    @Module({ providers: [PersistenceModule.auditWriterFor('alpha')] })
    class AlphaModule {}
    @Module({ providers: [{ provide: 'ROGUE', inject: [AUDIT_WRITER], useFactory: () => 1 }] })
    class RogueModule {}

    await expect(compileWith(AlphaModule, RogueModule)).rejects.toThrow(
      /can't resolve dependencies/i,
    );
  });

  it('exports, from no module of the graph, anything that hands out a writer by owner', async () => {
    const moduleRef = await apiGraph();
    const offenders: string[] = [];
    for (const nestModule of nestModulesOf(moduleRef)) {
      for (const token of nestModule.exports) {
        let instance: unknown;
        try {
          instance = moduleRef.get(token as symbol, { strict: false });
        } catch {
          continue; // A re-exported module, not a provider.
        }
        if (
          typeof instance === 'object' &&
          instance !== null &&
          ('record' in instance || 'forOwner' in instance || 'forModule' in instance)
        ) {
          offenders.push(`${nestModule.metatype.name}:${String(token)}`);
        }
      }
    }
    await moduleRef.close();

    expect(offenders).toEqual([]);
  });

  it('refuses a malformed owner when the binding is declared', () => {
    for (const owner of ['platform', 'Identity', 'identity.role', 'platform.ai.x', '']) {
      expect(() => PersistenceModule.auditWriterFor(owner)).toThrow(/module name/);
    }
  });
});
