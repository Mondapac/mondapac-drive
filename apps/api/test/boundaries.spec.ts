import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ESLint } from 'eslint';
import type { Linter } from 'eslint';
import * as ts from 'typescript';

const API_ROOT = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(API_ROOT, '../..');
const FIXTURES = path.join(__dirname, 'boundary-fixtures');

// The cold start of the type-aware ESLint run and of dependency-cruiser exceeds Jest's
// default 5 s when the machine is busy; each runs once, in a beforeAll with this timeout.
const SETUP_TIMEOUT_MS = 60_000;

interface Rule {
  name: string;
  severity: string;
}

interface Violation {
  from: string;
  to: string;
  rule: Rule;
}

interface CruiseResult {
  modules: { source: string; dependencies: { module: string; resolved: string }[] }[];
  summary: { violations: Violation[]; ruleSetUsed: { forbidden: Rule[] } };
}

/** Runs the real dependency-cruiser configuration against the fixture tree. */
function cruiseFixtures(): CruiseResult {
  let output: string;
  try {
    output = execFileSync(
      process.execPath,
      [
        path.join(API_ROOT, 'node_modules/dependency-cruiser/bin/dependency-cruiser.mjs'),
        'src',
        '--config',
        path.join(API_ROOT, '.dependency-cruiser.cjs'),
        '--output-type',
        'json',
      ],
      { cwd: FIXTURES, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
  } catch (error) {
    // dependency-cruiser exits non-zero when it finds violations; the report is on stdout.
    output = (error as { stdout: string }).stdout;
  }
  return JSON.parse(output) as CruiseResult;
}

/**
 * Every name a TypeScript file exports, read from its syntax: declarations, export lists,
 * re-exports (`export *` is reported as `*`) and default exports. Types count too.
 */
function exportedNames(file: string): string[] {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const names: string[] = [];
  for (const statement of source.statements) {
    if (ts.isExportDeclaration(statement)) {
      const clause = statement.exportClause;
      if (clause === undefined) names.push('*');
      else if (ts.isNamespaceExport(clause)) names.push(clause.name.text);
      else names.push(...clause.elements.map((element) => element.name.text));
    } else if (ts.isExportAssignment(statement)) {
      names.push('default');
    } else if (ts.canHaveModifiers(statement)) {
      const modifiers = ts.getModifiers(statement)?.map((modifier) => modifier.kind) ?? [];
      if (!modifiers.includes(ts.SyntaxKind.ExportKeyword)) continue;
      if (modifiers.includes(ts.SyntaxKind.DefaultKeyword)) names.push('default');
      else if (ts.isVariableStatement(statement)) {
        names.push(
          ...statement.declarationList.declarations.map((variable) =>
            variable.name.getText(source),
          ),
        );
      } else {
        const { name } = statement as ts.Statement & { name?: ts.Node };
        names.push(name?.getText(source) ?? '?');
      }
    }
  }
  return names.sort();
}

/** `<ESLint rule>: <design rule>` of a message, the design rule being its message prefix. */
function label(message: Linter.LintMessage): string {
  const rule = /\b([a-z]+(?:-[a-z]+)+): /.exec(message.message)?.[1] ?? message.message;
  return `${message.ruleId}: ${rule}`;
}

const times = (count: number, entry: string): string[] => Array<string>(count).fill(entry);
const syntax = (rule: string, count = 1): string[] => times(count, `no-restricted-syntax: ${rule}`);
const properties = (rule: string, count = 1): string[] =>
  times(count, `no-restricted-properties: ${rule}`);
const imports = (rule: string, count = 1): string[] =>
  times(count, `@typescript-eslint/no-restricted-imports: ${rule}`);
const kernelImports = (count = 1): string[] =>
  times(count, 'no-restricted-imports: kernel-imports-only-itself');

describe('architecture boundaries (ADR-0008 decision 6)', () => {
  describe('dependency-cruiser', () => {
    let cruise: CruiseResult;
    let found: string[];

    beforeAll(() => {
      cruise = cruiseFixtures();
      found = cruise.summary.violations
        .map((violation) => `${violation.rule.name}: ${violation.from}`)
        .sort();
    }, SETUP_TIMEOUT_MS);

    it('declares these rules, each as an error', () => {
      const rules = cruise.summary.ruleSetUsed.forbidden;

      expect(rules.map((rule) => rule.name).sort()).toEqual([
        'application-does-not-know-delivery',
        'approved-seller-zones-contract-is-for-certification',
        'approved-seller-zones-use-cases-stay-in-sellers-reader',
        'authenticated-actor-is-built-by-the-authenticator',
        'catalog-imports-neither-pricing-nor-inventory',
        'certification-surface-does-not-reach-reader-adapter',
        'contexts-are-built-by-platform',
        'core-does-not-import-verticals',
        'database-driver-only-in-infrastructure',
        'domain-is-pure',
        'identity-imports-no-module',
        'inventory-ordering-port-is-for-ordering',
        'kernel-only-through-package-entries',
        'kernel-testing-only-in-tests',
        'market-context-is-attached-by-the-guard',
        'market-context-only-through-the-decorator',
        'market-exemption-is-platform-only',
        'model-entry-only-from-the-allow-list',
        'model-provider-sdks-only-in-platform-ai',
        'module-internals-are-private',
        'module-public-api-only',
        'modules-reach-authz-through-its-barrel',
        'no-circular',
        'persistence-internals-are-private',
        'persistence-root-is-private',
        'platform-does-not-import-modules',
        'prisma-only-in-infrastructure',
        'repositories-stay-behind-use-cases',
        'request-actor-is-attached-by-the-actor-guard',
        'seller-access-contract-is-for-sellers',
        'sql-parser-only-in-pg-parser',
        'subject-keys-only-in-infrastructure',
        'subject-keys-only-through-the-port',
        'temporal-only-through-kernel',
        'use-case-gate-is-built-by-authz',
        'use-cases-are-the-only-way-in',
      ]);
      expect(rules.filter((rule) => rule.severity !== 'error')).toEqual([]);
      expect(cruise.summary.violations.filter((v) => v.rule.severity !== 'error')).toEqual([]);
    });

    it('reports every deliberate violation in the fixtures, and nothing else', () => {
      expect(found).toEqual([
        'application-does-not-know-delivery: src/modules/alpha/application/knows-delivery.ts',
        'approved-seller-zones-contract-is-for-certification: src/modules/alpha/application/reads-approved-seller-zones.ts',
        'approved-seller-zones-contract-is-for-certification: src/modules/certification/presentation/reads-approved-seller-zones.ts',
        'approved-seller-zones-use-cases-stay-in-sellers-reader: src/modules/sellers/presentation/reaches-zone-use-case.ts',
        'authenticated-actor-is-built-by-the-authenticator: src/modules/identity/application/mints-authenticated-actor.ts',
        'authenticated-actor-is-built-by-the-authenticator: src/platform/mints-authenticated-actor.ts',
        'catalog-imports-neither-pricing-nor-inventory: src/modules/catalog/application/imports-inventory.ts',
        'catalog-imports-neither-pricing-nor-inventory: src/modules/catalog/application/imports-pricing.ts',
        'certification-surface-does-not-reach-reader-adapter: src/modules/certification/presentation/imports-infrastructure.ts',
        'contexts-are-built-by-platform: src/modules/alpha/application/builds-call-context.ts',
        'contexts-are-built-by-platform: src/modules/alpha/application/mints-actor-context.ts',
        'contexts-are-built-by-platform: src/modules/alpha/application/uses-context-types.ts',
        'core-does-not-import-verticals: src/platform/uses-vertical.ts',
        'database-driver-only-in-infrastructure: src/platform/uses-database-driver.ts',
        'domain-is-pure: src/modules/alpha/domain/does-io.ts',
        'domain-is-pure: src/modules/alpha/domain/imports-application.ts',
        'identity-imports-no-module: src/modules/identity/application/imports-another-module.ts',
        'inventory-ordering-port-is-for-ordering: src/modules/alpha/application/reads-inventory-ordering-port.ts',
        'kernel-only-through-package-entries: src/modules/alpha/infrastructure/reaches-kernel-by-path.ts',
        'kernel-only-through-package-entries: src/platform/binds-built-test-fake.ts',
        'kernel-only-through-package-entries: src/platform/reaches-kernel-dist-by-path.ts',
        'kernel-only-through-package-entries: src/platform/reaches-kernel-dist.ts',
        'kernel-only-through-package-entries: src/platform/reaches-kernel-subpath.ts',
        'kernel-testing-only-in-tests: packages/shared-kernel/src/index.ts',
        'kernel-testing-only-in-tests: src/platform/binds-built-test-fake.ts',
        'kernel-testing-only-in-tests: src/platform/binds-test-fake.ts',
        'market-context-is-attached-by-the-guard: src/platform/reaches-attached-market-context.ts',
        'market-context-only-through-the-decorator: src/modules/alpha/application/mints-market-context-indirectly.ts',
        'market-context-only-through-the-decorator: src/modules/alpha/application/mints-market-context.ts',
        'market-context-only-through-the-decorator: src/modules/alpha/infrastructure/copies-health-exemption.ts',
        'market-context-only-through-the-decorator: src/modules/alpha/presentation/exempt-controller.ts',
        'market-exemption-is-platform-only: src/modules/alpha/presentation/exempt-controller.ts',
        'market-exemption-is-platform-only: src/platform/market-context/index.ts',
        'model-entry-only-from-the-allow-list: src/modules/alpha/infrastructure/reaches-model-gateway.ts',
        'model-provider-sdks-only-in-platform-ai: src/modules/alpha/infrastructure/imports-provider-sdk.ts',
        'module-internals-are-private: src/platform/reaches-into-module.ts',
        'module-public-api-only: src/modules/alpha/application/reaches-into-module.ts',
        'modules-reach-authz-through-its-barrel: src/modules/alpha/application/reaches-use-case-gate.ts',
        'no-circular: src/modules/alpha/domain/circular-a.ts',
        'persistence-internals-are-private: src/modules/alpha/application/reaches-audit-writer.ts',
        'persistence-internals-are-private: src/modules/alpha/application/uses-prisma-service.ts',
        'persistence-internals-are-private: src/modules/alpha/application/uses-prisma-via-barrel.ts',
        'persistence-root-is-private: src/modules/alpha/infrastructure/reaches-audit-writer.ts',
        'persistence-root-is-private: src/modules/alpha/infrastructure/uses-prisma-root.ts',
        'platform-does-not-import-modules: src/platform/imports-module-index.ts',
        'platform-does-not-import-modules: src/platform/reaches-into-module.ts',
        'prisma-only-in-infrastructure: src/modules/alpha/presentation/uses-prisma.ts',
        'repositories-stay-behind-use-cases: src/modules/alpha/presentation/jobs/reaches-repository.ts',
        'request-actor-is-attached-by-the-actor-guard: src/modules/alpha/presentation/attaches-actor.ts',
        'seller-access-contract-is-for-sellers: src/modules/alpha/application/reads-seller-access.ts',
        'sql-parser-only-in-pg-parser: src/platform/uses-sql-parser.ts',
        'subject-keys-only-in-infrastructure: src/modules/alpha/application/uses-subject-keys.ts',
        'subject-keys-only-through-the-port: src/modules/alpha/infrastructure/reaches-key-wrapper.ts',
        'temporal-only-through-kernel: src/platform/uses-js-temporal-polyfill.ts',
        'temporal-only-through-kernel: src/platform/uses-temporal-polyfill.ts',
        'use-case-gate-is-built-by-authz: src/modules/alpha/application/reaches-use-case-gate.ts',
        'use-case-gate-is-built-by-authz: src/platform/builds-use-case-gate.ts',
        'use-cases-are-the-only-way-in: src/modules/alpha/infrastructure/alpha.facade.ts',
        'use-cases-are-the-only-way-in: src/modules/alpha/presentation/reaches-application-service.ts',
        'use-cases-are-the-only-way-in: src/modules/beta/index.ts',
      ]);
    });

    it('has a fixture that breaks every rule of the configuration', () => {
      const rules = cruise.summary.ruleSetUsed.forbidden.map((rule) => rule.name);
      const broken = new Set(cruise.summary.violations.map((violation) => violation.rule.name));

      expect(rules.filter((name) => !broken.has(name))).toEqual([]);
    });

    it('lets domain/ import the shared kernel by its package name, through tsconfig paths', () => {
      const domainFile = cruise.modules.find(
        (module) => module.source === 'src/modules/alpha/domain/uses-kernel.ts',
      );

      expect(new Set(domainFile?.dependencies.map((dependency) => dependency.resolved))).toEqual(
        new Set(['packages/shared-kernel/src/index.ts']),
      );
      expect(found.filter((violation) => violation.endsWith('/uses-kernel.ts'))).toEqual([]);
    });

    it.each([
      // The two importers allowed to use the market exemption.
      'src/platform/market-context/market-context.guard.ts',
      'src/platform/health/health.controller.ts',
      // A module reads its Market through @Market().
      'src/modules/alpha/presentation/market-controller.ts',
      // identity may import its own files.
      'src/modules/identity/application/uses-own-domain.ts',
      // sellers consumes identity's seller-access contract (ADR-0022 decision 6).
      'src/modules/sellers/application/reads-seller-access.ts',
      // certification's application layer consumes sellers' approved-seller-zones contract.
      'src/modules/certification/application/reads-approved-seller-zones.ts',
      'src/modules/certification/infrastructure/reads-approved-seller-zones.ts',
      'src/modules/sellers/presentation/approved-seller-zones.reader.ts',
      // identity's Authenticator alone builds authenticated actors (slice 2).
      'src/modules/identity/application/access/session-authenticator.ts',
      // A module's infrastructure reaches the database through PrismaService only.
      'src/modules/alpha/infrastructure/uses-prisma-service.ts',
      // A platform entry adapter builds actors and call contexts (identity slice 1c).
      'src/platform/scheduler/builds-system-context.ts',
      // Rule 9: an entry point calls a use case; a use case and infrastructure use the
      // repository; the module's Nest module binds the implementation.
      'src/modules/alpha/presentation/calls-use-case.ts',
      'src/modules/alpha/application/use-cases/find-thing.use-case.ts',
      'src/modules/alpha/infrastructure/prisma-thing.repository.ts',
      'src/modules/alpha/alpha.module.ts',
      // M1: platform/authz builds the gate; a module imports the barrel.
      'src/platform/authz/authz.module.ts',
      'src/modules/alpha/application/uses-authz-barrel.ts',
      // L3: a module's infrastructure uses the SubjectKeyService port and its labels.
      'src/modules/alpha/infrastructure/encrypts-field.ts',
    ])('accepts the allowed file %s', (file) => {
      expect(cruise.modules.map((module) => module.source)).toContain(file);
      expect(found.filter((violation) => violation.endsWith(`: ${file}`))).toEqual([]);
    });
  });

  describe('Prisma boundaries (scripts/check-prisma-boundaries.mjs; platform persistence 9)', () => {
    const PRISMA_FIXTURES = path.join(FIXTURES, 'prisma');

    /** Runs the real script, as `pnpm boundaries` does; answers its exit code and problems. */
    function checkPrisma(
      schemaDir: string,
      srcDir: string,
    ): { status: number; problems: string[] } {
      try {
        execFileSync(
          process.execPath,
          [path.join(REPO_ROOT, 'scripts/check-prisma-boundaries.mjs'), schemaDir, '--src', srcDir],
          { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
        );
        return { status: 0, problems: [] };
      } catch (error) {
        const { status, stderr } = error as { status: number; stderr: string };
        const problems = stderr
          .split('\n')
          .filter((line) => line.startsWith('  - '))
          .map((line) => line.slice(4));
        return { status, problems };
      }
    }

    it('accepts the real schema and the real sources', () => {
      expect(
        checkPrisma(path.join(REPO_ROOT, 'prisma/schema'), path.join(API_ROOT, 'src')),
      ).toEqual({ status: 0, problems: [] });
    });

    it('accepts the passing fixture: a name:-named selector, @@unique([kind, marketId]), a composite foreign key, an exempt model, identical outboxes, an event-keyed inbox and event_delivery, the outbox exception and the audit folder', () => {
      expect(
        checkPrisma(
          path.join(PRISMA_FIXTURES, 'passing/schema'),
          path.join(PRISMA_FIXTURES, 'passing/src'),
        ),
      ).toEqual({ status: 0, problems: [] });
    });

    it('rejects every deliberate violation of the failing fixture, and nothing else', () => {
      const { status, problems } = checkPrisma(
        path.join(PRISMA_FIXTURES, 'failing/schema'),
        path.join(PRISMA_FIXTURES, 'failing/src'),
      );

      expect(status).toBe(1);
      expect(problems.sort()).toEqual(
        [
          'alpha.prisma: model AlphaWrongSchema is in schema "beta", but this file owns "alpha"',
          'alpha.prisma: AlphaNeither is neither market-scoped (marketId and tenantId) nor exempt ("/// @market-scope none: <reason>")',
          'alpha.prisma: AlphaBoth has marketId and tenantId and also an exemption line',
          'alpha.prisma: AlphaMarketOnly has marketId without tenantId',
          'alpha.prisma: AlphaBadKeys @unique on ref does not contain marketId',
          'alpha.prisma: AlphaBadKeys @@id([kind, code]) does not contain marketId',
          'alpha.prisma: AlphaBadKeys @@unique([kind, ref]) does not contain marketId',
          'alpha.prisma: AlphaIntId @id on id does not contain marketId',
          'alpha.prisma: AlphaChildNoMarket.parent relates two market-scoped models without marketId in both fields and references (PM6)',
          'alpha.prisma: AlphaChildMisaligned.parent pairs marketId with another column (marketId is at different positions in fields and references; PM6)',
          'alpha.prisma: AlphaScopedChild.parent relates a market-scoped model to the exempt model AlphaExemptParent; exempt and market-scoped models may not relate',
          'alpha.prisma: AlphaExemptChild.parent relates an exempt model to the market-scoped model AlphaParent; exempt and market-scoped models may not relate',
          'beta.prisma: BetaOutbox is an outbox whose fields differ from AlphaOutbox',
          'modules/alpha/infrastructure/hides-model.ts:9: destructured property "betaThing" names model BetaThing, which belongs to module "beta"',
          'modules/alpha/infrastructure/hides-model.ts:10: destructured property "betaThing" names model BetaThing, which belongs to module "beta"',
          'modules/alpha/infrastructure/hides-model.ts:10: destructured property "auditLog" names model AuditLog, which is reserved to platform/persistence/audit/ (write it through AuditWriter)',
          'modules/alpha/infrastructure/hides-model.ts:11: a computed key on a tx(...) result hides the model it names; name the model as a property',
          'modules/alpha/infrastructure/hides-model.ts:12: a computed key on a tx(...) result hides the model it names; name the model as a property',
          'modules/alpha/infrastructure/hides-model.ts:13: property ".auditLog" names model AuditLog, which is reserved to platform/persistence/audit/ (write it through AuditWriter)',
          'modules/alpha/infrastructure/reaches-beta.ts:2: import of "BetaThing" names model BetaThing, which belongs to module "beta"',
          'modules/alpha/infrastructure/reaches-beta.ts:3: import "../../../generated/prisma/models/BetaThing" names model BetaThing, which belongs to module "beta"',
          'modules/alpha/infrastructure/reaches-beta.ts:3: import of "BetaThingModel" names model BetaThing, which belongs to module "beta"',
          'modules/alpha/infrastructure/reaches-beta.ts:7: type "Prisma.BetaThingWhereInput" names model BetaThing, which belongs to module "beta"',
          'modules/alpha/infrastructure/reaches-beta.ts:8: property ["betaThing"] names model BetaThing, which belongs to module "beta"',
          'modules/alpha/infrastructure/reaches-beta.ts:9: property ".betaThing" names model BetaThing, which belongs to module "beta"',
          'modules/alpha/infrastructure/writes-own-outbox.ts:5: property ".alphaOutbox" names model AlphaOutbox, which is reserved to platform/persistence/outbox/ (write it through OutboxWriter)',
          'raw read statement alpha.deletes: not-a-select',
          'raw read statement alpha.reads-beta: relation-schema:beta.thing',
          'raw read statement alpha.no-market-term: market-rule:p',
          'raw read statement alpha.no-market-term: param-unused:$2',
          'modules/alpha/infrastructure/imports-driver.ts:2: import of the database driver "pg" outside the files of DRIVER_FILES (ADR-0030)',
          'modules/alpha/infrastructure/raw-reads-badly.ts:9: rawRead names "alpha.missing", which is not in the list',
          'modules/alpha/infrastructure/raw-reads-badly.ts:10: rawRead needs a string literal statement id as its second argument',
          'modules/alpha/infrastructure/raw-reads-badly.ts:11: raw SQL outside the files of RAW_SQL_FILES; read through RawReadPort (ADR-0030)',
          'modules/alpha/infrastructure/raw-reads-badly.ts:12: raw SQL outside the files of RAW_SQL_FILES; read through RawReadPort (ADR-0030)',
          'modules/alpha/infrastructure/raw-forms.ts:7: raw SQL outside the files of RAW_SQL_FILES; read through RawReadPort (ADR-0030)',
          'modules/alpha/infrastructure/raw-forms.ts:8: raw SQL outside the files of RAW_SQL_FILES; read through RawReadPort (ADR-0030)',
          'modules/alpha/infrastructure/raw-forms.ts:9: raw SQL outside the files of RAW_SQL_FILES; read through RawReadPort (ADR-0030)',
          'modules/alpha/infrastructure/raw-forms.ts:10: raw SQL outside the files of RAW_SQL_FILES; read through RawReadPort (ADR-0030)',
          'modules/alpha/infrastructure/raw-forms.ts:11: import of the database driver "pg" outside the files of DRIVER_FILES (ADR-0030)',
          'modules/alpha/infrastructure/raw-forms.ts:12: import of the database driver "pg-pool" outside the files of DRIVER_FILES (ADR-0030)',
          "modules/alpha/infrastructure/raw-forms.ts:13: rawRead must be called directly as .rawRead(market, '<id>', ...)",
          "modules/alpha/infrastructure/raw-forms.ts:14: rawRead must be called directly as .rawRead(market, '<id>', ...)",
          'modules/alpha/infrastructure/raw-forms.ts:26: import of the database driver "postgres" outside the files of DRIVER_FILES (ADR-0030)',
          'modules/alpha/infrastructure/raw-forms.ts:29: raw SQL outside the files of RAW_SQL_FILES; read through RawReadPort (ADR-0030)',
          'modules/alpha/infrastructure/raw-forms.ts:30: require/import() needs a string literal specifier (a computed one could load the database driver; ADR-0030)',
          'modules/alpha/infrastructure/raw-forms.ts:32: import of the database driver "postgres/cjs/src/index.js" outside the files of DRIVER_FILES (ADR-0030)',
          'modules/beta/infrastructure/calls-alpha.ts:5: rawRead "alpha.sound" belongs to module "alpha"; call it from that module\'s infrastructure folder',
          'platform/persistence/outbox/reaches-module.ts:6: property ".betaThing" names model BetaThing, which belongs to module "beta"',
          'platform/persistence/reaches-module.ts:6: property ".auditLog" names model AuditLog, which is reserved to platform/persistence/audit/ (write it through AuditWriter)',
          'platform/persistence/reaches-module.ts:7: property ".alphaParent" names model AlphaParent, which belongs to module "alpha"',
        ].sort(),
      );
    });
  });

  describe('the model map generator (scripts/generate-model-map.mjs; platform persistence 9)', () => {
    const GENERATOR = path.join(REPO_ROOT, 'scripts/generate-model-map.mjs');

    function generate(schemaDir: string): { status: number; output: string } {
      try {
        const output = execFileSync(
          process.execPath,
          [GENERATOR, '--schema', schemaDir, '--json'],
          {
            cwd: REPO_ROOT,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        );
        return { status: 0, output };
      } catch (error) {
        const { status, stderr } = error as { status: number; stderr: string };
        return { status, output: stderr };
      }
    }

    it('maps owner, table, scope, relation fields, compound selectors and foreign keys', () => {
      const { status, output } = generate(path.join(FIXTURES, 'prisma/passing/schema'));
      const map = JSON.parse(output) as {
        models: Record<string, Record<string, unknown>>;
        modules: Record<string, unknown>;
      };

      expect(status).toBe(0);
      expect(map.models.AlphaParent).toEqual({
        module: 'alpha',
        schema: 'alpha',
        table: 'parent',
        clientProperty: 'alphaParent',
        scope: 'scoped',
        scalarFields: ['id', 'marketId', 'tenantId', 'code', 'kind'],
        relationFields: ['children'],
        idField: 'id',
        compoundSelectors: [
          { name: 'marketId_id', fields: ['marketId', 'id'] },
          { name: 'byCode', fields: ['marketId', 'code'] },
          { name: 'kind_marketId', fields: ['kind', 'marketId'] },
        ],
        foreignKeys: [],
      });
      expect(map.models.AlphaChild).toMatchObject({
        relationFields: ['parent'],
        foreignKeys: [
          {
            field: 'parent',
            target: 'AlphaParent',
            targetTable: 'parent',
            fields: ['marketId', 'parentId'],
            references: ['marketId', 'id'],
            columns: ['market_id', 'parent_id'],
            referencedColumns: ['market_id', 'id'],
          },
        ],
      });
      expect(map.models.AlphaThrottle).toMatchObject({
        idField: null,
        compoundSelectors: [
          { name: 'marketId_kind_keyHash', fields: ['marketId', 'kind', 'keyHash'] },
        ],
      });
      expect(map.models.AlphaLookup).toMatchObject({ scope: 'exempt' });
      expect(map.modules).toEqual({
        alpha: { schema: 'alpha', outboxModel: 'AlphaOutbox', inboxModel: null },
        beta: { schema: 'beta', outboxModel: 'BetaOutbox', inboxModel: 'BetaInbox' },
        platform: { schema: 'platform', outboxModel: null, inboxModel: null },
      });
    });

    it('fails on a model with neither scope marker, both, or one of the two columns', () => {
      const { status, output } = generate(path.join(FIXTURES, 'prisma/failing/schema'));

      expect(status).toBe(1);
      expect(output).toContain('AlphaNeither has neither marketId and tenantId nor');
      expect(output).toContain('AlphaBoth has marketId and tenantId and an exemption line');
      expect(output).toContain('AlphaMarketOnly has only one of marketId and tenantId');
    });

    it("fails when its parse disagrees with Prisma's DMMF", () => {
      const script = `
        import { buildModelMap, compareWithDmmf } from ${JSON.stringify(pathToFileURL(GENERATOR).href)};
        const map = buildModelMap(${JSON.stringify(path.join(FIXTURES, 'prisma/passing/schema'))});
        const models = Object.keys(map.models).map((name) => ({
          name,
          fields: [...map.models[name].scalarFields.map((f) => ({ name: f, kind: 'scalar', isId: f === map.models[name].idField })),
                   ...map.models[name].relationFields.map((f) => ({ name: f, kind: 'object' }))],
          primaryKey: null,
          uniqueIndexes: map.models[name].compoundSelectors,
        }));
        models.find((m) => m.name === 'AlphaParent').fields.push({ name: 'hidden', kind: 'object' });
        try { compareWithDmmf(map, { datamodel: { models } }); console.log('accepted'); }
        catch (error) { console.log(error.message); }`;
      const output = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
        encoding: 'utf8',
      });

      expect(output).toContain('The model map parser disagrees with Prisma');
      expect(output).toContain('AlphaParent: relation fields differ from the DMMF');
    });
  });

  describe('source files', () => {
    // Every lint block names .ts, .mts and .cts, and the dependency-cruiser patterns end in
    // .ts; source of any other kind would escape them. Placeholders and notes are allowed.
    it.each(['apps/api/src', 'packages/shared-kernel/src'])('%s holds only .ts files', (dir) => {
      const others = readdirSync(path.join(REPO_ROOT, dir), {
        recursive: true,
        withFileTypes: true,
      })
        .filter((entry) => entry.isFile() && !entry.name.endsWith('.ts'))
        .filter((entry) => !['.gitkeep', 'README.md'].includes(entry.name))
        .map((entry) => path.relative(REPO_ROOT, path.join(entry.parentPath, entry.name)));

      expect(others).toEqual([]);
    });
  });

  describe('exports of the files platform/ lets others import', () => {
    // persistence-internals-are-private and market-exemption-is-platform-only allow-list
    // these files, so a re-export from them would carry the client or the exemption past
    // the rule (docs/reviews/phase-1.md; CTO decision on slice 0 item 3).
    it.each([
      ['src/platform/persistence/persistence.module.ts', ['PersistenceModule']],
      ['src/platform/persistence/database-probe.ts', ['DatabaseProbe']],
      // persistence-root-is-private lets module infrastructure import this file only.
      [
        'src/platform/persistence/prisma.service.ts',
        [
          'LockedStockItem',
          'MarketTransaction',
          'NamedStatementName',
          'NamedStatementParams',
          'NamedStatementRow',
          'PrismaService',
        ],
      ],
      // persistence-root-is-private lets module infrastructure import the read-only port
      // (ADR-0030); its implementation is in another file.
      [
        'src/platform/persistence/raw-reads/raw-read-port.ts',
        ['RAW_READ_PORT', 'RawReadName', 'RawReadParams', 'RawReadPort', 'RawReadRow'],
      ],
      // persistence-internals-are-private lets the logger import the error reducer.
      [
        'src/platform/persistence/database-error.ts',
        ['ReducedDatabaseError', 'reduceDatabaseError'],
      ],
      [
        'src/platform/market-context/market-context.guard.ts',
        ['MarketContextGuard', 'isMarketContextExempt'],
      ],
      ['src/platform/health/health.controller.ts', ['HealthController']],
    ])('%s exports only %j', (file, names) => {
      expect(exportedNames(path.join(API_ROOT, file))).toEqual([...names].sort());
    });

    it('sees a re-export (negative control on a fixture barrel)', () => {
      expect(exportedNames(path.join(FIXTURES, 'src/platform/persistence/index.ts'))).toEqual([
        'PrismaService',
      ]);
    });
  });

  describe('ESLint', () => {
    let eslint: ESLint;
    const results = new Map<string, Linter.LintMessage[]>();
    // With noInlineConfig ESLint adds a warning (no rule id) for every directive it ignores.
    // Those notices are split off here and asserted on their own; every other message must
    // still be an error.
    const ignoredDirectives = new Map<string, string[]>();
    const IGNORED_DIRECTIVE =
      /^'\/\/ eslint-disable[^']*' has no effect because you have 'noInlineConfig'/;

    beforeAll(async () => {
      // One instance and one run over the whole fixture tree: the type-aware parser builds
      // its program once.
      eslint = new ESLint({ cwd: REPO_ROOT, ignore: false });
      const linted = await eslint.lintFiles([
        path.join(FIXTURES, 'src/**/*.ts'),
        path.join(FIXTURES, 'packages/**/*.ts'),
      ]);
      for (const result of linted) {
        const file = path.relative(FIXTURES, result.filePath);
        const notices = result.messages.filter(
          (message) => message.ruleId === null && IGNORED_DIRECTIVE.test(message.message),
        );
        if (notices.length > 0)
          ignoredDirectives.set(
            file,
            notices.map((m) => m.message),
          );
        results.set(
          file,
          result.messages.filter((message) => !notices.includes(message)),
        );
      }
    }, SETUP_TIMEOUT_MS);

    /** The messages of a fixture; each must be an error, so that it fails `pnpm lint`. */
    function messagesIn(file: string): Linter.LintMessage[] {
      const messages = results.get(file);
      if (messages === undefined) throw new Error(`${file} was not linted`);
      expect(messages.filter((message) => message.severity !== 2)).toEqual([]);
      return messages;
    }

    const syntaxOf = (file: string): string[] =>
      textsIn(file).map((text) => text.split(':')[0] ?? text);
    const rulesIn = (file: string): string[] => messagesIn(file).map(label).sort();
    const textsIn = (file: string): string[] => messagesIn(file).map((m) => m.message);

    it('reports every message of every fixture as an error', () => {
      const notErrors = [...results].flatMap(([file, messages]) =>
        messages.filter((message) => message.severity !== 2).map(() => file),
      );

      expect(results.size).toBeGreaterThan(50);
      expect(notErrors).toEqual([]);
    });

    it.each<[string, string[]]>([
      // Rule 4, no-wall-clock: every core layer and the kernel; only platform/clock/ reads it.
      ['src/modules/alpha/domain/wall-clock.ts', syntax('no-wall-clock', 2)],
      ['src/modules/alpha/infrastructure/reads-wall-clock.ts', syntax('no-wall-clock')],
      ['src/platform/reads-wall-clock.ts', syntax('no-wall-clock', 4)],
      ['packages/shared-kernel/src/reads-wall-clock.ts', syntax('no-wall-clock')],
      ['src/platform/clock/system-clock.ts', []],
      // Rule 4: no Date conversion in domain/ and application/; infrastructure/ converts.
      ['src/modules/alpha/domain/converts-date.ts', syntax('no-wall-clock')],
      ['src/modules/alpha/application/converts-date.ts', syntax('no-wall-clock')],
      ['src/modules/alpha/infrastructure/converts-date.ts', []],
      // P 12.2 rule 4: raw SQL and $transaction are platform-only; modules never use them.
      [
        'src/modules/alpha/infrastructure/uses-raw-sql.ts',
        syntax('no-raw-sql-or-transaction-in-modules', 6),
      ],
      [
        'src/modules/alpha/application/uses-transaction.ts',
        syntax('no-raw-sql-or-transaction-in-modules'),
      ],
      ['src/platform/uses-raw-sql.ts', []],
      // P 12.2 rule 3: only main.ts and platform/worker/ read appRole.
      ['src/platform/reads-app-role.ts', properties('app-role-is-read-in-two-places', 2)],
      [
        'src/modules/alpha/application/reads-app-role.ts',
        properties('app-role-is-read-in-two-places'),
      ],
      ['src/main.ts', []],
      ['src/platform/worker/starts-worker.ts', []],
      // ADR-0037 decision 8: only platform/http/client-address.ts reads the socket's address.
      ['src/platform/reads-remote-address.ts', properties('client-address-is-resolved-once', 3)],
      [
        'src/modules/alpha/presentation/reads-remote-address.ts',
        properties('client-address-is-resolved-once'),
      ],
      ['src/platform/http/client-address.ts', []],
      // Rule 5: the named import and its namespace form, the factory import.
      [
        'src/modules/alpha/application/mints-market-context.ts',
        [
          ...imports('contexts-are-minted-by-platform', 2),
          ...syntax('contexts-are-minted-by-platform', 3),
        ],
      ],
      // Rule 5: namespace import, re-export, destructuring (also computed), computed member,
      // qualified type.
      [
        'src/modules/alpha/application/mints-market-context-indirectly.ts',
        [
          ...imports('contexts-are-minted-by-platform', 2),
          ...syntax('contexts-are-minted-by-platform', 5),
        ],
      ],
      [
        'src/modules/alpha/application/reexports-kernel.ts',
        imports('contexts-are-minted-by-platform'),
      ],
      [
        'src/modules/alpha/infrastructure/discovers-providers.ts',
        imports('contexts-are-minted-by-platform', 3),
      ],
      [
        'src/modules/alpha/application/asserts-market-context.ts',
        syntax('contexts-are-minted-by-platform', 3),
      ],
      ['src/platform/market-context/market-context.factory.ts', []],
      // Slice 1c, rule 5: the actor and CallContext constructors and types are minted by the
      // platform, and the `contexts` entry is refused by path name (the entry need not exist).
      [
        'src/modules/alpha/application/mints-actor-context.ts',
        [
          ...imports('contexts-are-minted-by-platform', 2),
          ...syntax('contexts-are-minted-by-platform', 5),
        ],
      ],
      [
        'src/modules/alpha/application/uses-context-types.ts',
        imports('contexts-are-minted-by-platform'),
      ],
      // Slice 1c, use-case-entry-is-the-gate: no execute override in use-cases/. Slice 2 (W7,
      // W8): no `handle` reached on another object, by destructuring or by reflection in any
      // file of a module.
      [
        'src/modules/alpha/application/use-cases/overrides-execute.ts',
        syntax('use-case-entry-is-the-gate', 3),
      ],
      [
        'src/modules/alpha/application/use-cases/calls-handle.ts',
        syntax('use-case-entry-is-the-gate', 4),
      ],
      ['src/modules/alpha/presentation/calls-handle.ts', syntax('use-case-entry-is-the-gate')],
      ['src/modules/alpha/application/use-cases/allowed-use-case.ts', []],
      [
        'src/modules/alpha/application/calls-handler-object.ts',
        syntax('use-case-entry-is-the-gate'),
      ],
      [
        'src/modules/alpha/infrastructure/calls-handle.facade.ts',
        syntax('use-case-entry-is-the-gate'),
      ],
      ['src/modules/alpha/application/reflects-handle.ts', syntax('use-case-entry-is-the-gate', 7)],
      // Slice 2, rule 5: the authenticated-actor constructor is refused in a module (import
      // path and name), except in identity's Authenticator; the platform may name it (the
      // dependency-cruiser rule refuses that import).
      [
        'src/modules/identity/application/mints-authenticated-actor.ts',
        [
          ...imports('contexts-are-minted-by-platform'),
          ...syntax('contexts-are-minted-by-platform'),
        ],
      ],
      ['src/modules/identity/application/access/session-authenticator.ts', []],
      ['src/platform/mints-authenticated-actor.ts', []],
      // Only the guard attaches a MarketContext, in every part of the API.
      [
        'src/platform/attaches-market-context.ts',
        syntax('only-the-guard-attaches-market-context', 2),
      ],
      [
        'src/modules/alpha/application/attaches-market-context.ts',
        syntax('only-the-guard-attaches-market-context'),
      ],
      [
        'src/modules/alpha/presentation/attaches-market-context.ts',
        syntax('only-the-guard-attaches-market-context'),
      ],
      ['src/attaches-market-context.ts', syntax('only-the-guard-attaches-market-context')],
      ['src/platform/market-context/market-context.guard.ts', []],
      ['src/modules/alpha/presentation/market-controller.ts', []],
      // Code is loaded by static imports only; modules and the kernel have no import() at all.
      ['src/platform/loads-code-dynamically.ts', syntax('imports-are-static', 5)],
      ['src/modules/alpha/application/imports-kernel-dynamically.ts', syntax('imports-are-static')],
      ['packages/shared-kernel/src/imports-dynamically.ts', syntax('kernel-imports-only-itself')],
      // Rule 7: the kernel imports only itself; time.ts alone imports the polyfill.
      ['packages/shared-kernel/src/imports-outside-itself.ts', kernelImports(5)],
      ['packages/shared-kernel/src/time.ts', []],
      ['packages/shared-kernel/src/index.ts', []],
      // Market and vertical literals.
      ['src/modules/alpha/application/clean.ts', []],
    ])('%s reports exactly %j', (file, expected) => {
      expect(rulesIn(file)).toEqual([...expected].sort());
    });

    it('names each wall-clock read', () => {
      expect(textsIn('src/platform/reads-wall-clock.ts')).toEqual([
        expect.stringMatching(/^no-wall-clock: new Date\(\) reads/),
        expect.stringMatching(/^no-wall-clock: Date\(\) reads/),
        expect.stringMatching(/^no-wall-clock: Date\.now\(\) reads/),
        expect.stringMatching(/^no-wall-clock: Temporal\.Now reads/),
      ]);
      expect(textsIn('src/modules/alpha/domain/converts-date.ts')).toEqual([
        expect.stringMatching(/^no-wall-clock: no Date in domain\/ or application\//),
      ]);
    });

    it('does not let an inline directive switch a rule off, and reports the ignored directive', () => {
      const file = 'src/modules/alpha/application/disables-a-rule.ts';

      expect(syntaxOf(file)).toEqual(['no-wall-clock']);
      expect([...ignoredDirectives.keys()]).toEqual([file]);
      expect(ignoredDirectives.get(file)).toEqual([
        expect.stringContaining("'// eslint-disable-next-line no-restricted-syntax' has no effect"),
      ]);
    });

    it('names each use-case-entry-is-the-gate message', () => {
      expect(textsIn('src/modules/alpha/application/use-cases/overrides-execute.ts')).toEqual(
        Array(3).fill('use-case-entry-is-the-gate: a use case never overrides execute.'),
      );
      expect(textsIn('src/modules/alpha/application/use-cases/calls-handle.ts')).toEqual(
        Array(4).fill('use-case-entry-is-the-gate: handle is called only by UseCase.execute.'),
      );
      expect(textsIn('src/modules/alpha/application/reflects-handle.ts')).toEqual(
        Array(7).fill(expect.stringMatching(/^use-case-entry-is-the-gate: /)),
      );
    });

    it('names each kernel import it refuses', () => {
      expect(
        textsIn('packages/shared-kernel/src/imports-outside-itself.ts').map(
          (message) => /'([^']+)' import/.exec(message)?.[1],
        ),
      ).toEqual([
        'os',
        'node:path',
        'zod',
        '../../../src/modules/alpha/domain/thing',
        'temporal-polyfill',
      ]);
    });

    it('refuses any other import in time.ts', async () => {
      const [result] = await eslint.lintText("export { EOL } from 'node:os';\n", {
        filePath: path.join(FIXTURES, 'packages/shared-kernel/src/time.ts'),
      });

      expect(result?.messages.map((message) => [message.severity, label(message)])).toEqual([
        [2, 'no-restricted-imports: kernel-imports-only-itself'],
      ]);
    });

    it('rejects hardcoded market identifiers in a module', () => {
      const messages = textsIn('src/modules/alpha/application/hardcoded-market.ts');

      expect(messages).toHaveLength(2);
      expect(messages.every((message) => /Market or vertical identifier/.test(message))).toBe(true);
    });

    it('rejects a hardcoded city name in a module, in a string and a template', () => {
      const messages = textsIn('src/modules/alpha/application/hardcoded-city.ts');

      expect(messages).toHaveLength(2);
      expect(messages.every((message) => /Market or vertical identifier/.test(message))).toBe(true);
    });

    it('rejects hardcoded market and city identifiers in platform code, including template strings', () => {
      const messages = textsIn('src/platform/hardcoded-vertical.ts');

      expect(messages).toHaveLength(2);
      expect(messages.every((message) => /Market or vertical identifier/.test(message))).toBe(true);
    });
  });
});
