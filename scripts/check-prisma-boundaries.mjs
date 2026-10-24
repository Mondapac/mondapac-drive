// Persistence boundaries (ADR-0004 decisions 2 and 3, ADR-0008 decision 6; platform
// persistence design, "P", sections 4.2, 9 and PM6). Run by `pnpm boundaries`, so by
// `pnpm verify` and CI; fixtures in apps/api/test/boundary-fixtures/prisma/ are asserted by
// apps/api/test/boundaries.spec.ts.
//
// Schema checks (prisma/schema/*.prisma, read by scripts/prisma-schema.mjs):
//   - <module>.prisma declares models and enums in schema "<module>" only (dashes become
//     underscores); base.prisma declares none; no relation crosses schemas;
//   - every model is scoped (marketId and tenantId) or exempt ("/// @market-scope none:
//     <reason>"), never neither or both; marketId and tenantId come together;
//   - every outbox model (@@map("outbox")) has the same fields;
//   - every @id, @unique, @@id and @@unique of a scoped model contains marketId, except the
//     single-column UUID @id and the ADR-0006 keys of the tables named in EVENT_KEYED_TABLES,
//     which lead with eventId;
//   - every @relation between two scoped models has marketId in both `fields` and
//     `references`, at the same position (PM6).
// Source check, "model to owning module" (P 9), on apps/api/src/modules/<m>/infrastructure/
// and apps/api/src/platform/persistence/: every reference to a Prisma model names a model of
// the file's own module (platform/ owns platform.prisma). A reference is a property of the
// model's client name (`.auditLog`, `["auditLog"]` or a destructured `{ auditLog }`), a
// `Prisma.<Model>...` name, a name imported from the generated client that starts with a
// model name, or an import from its `models/` folder. A non-literal key on the result of a
// `tx(...)` or `auditTx(...)` call (`tx(m)[key]`, `const { [key]: d } = tx(m)`) is refused,
// because it hides the model it names.
// Named exception: files under platform/persistence/outbox/ reach the models mapped to the
// tables in OUTBOX_TABLES of any module, and those models are reserved to that folder.
// Likewise the platform models mapped to AUDIT_TABLES are reserved to
// platform/persistence/audit/ (the AuditWriter; docs/design/domain/platform-audit.md 2).
// Raw read statements (ADR-0030, controls C2 and C3):
//   - when <src>/platform/persistence/raw-reads/statements.ts exists, the checked-in list is
//     transpiled, parsed with libpg-query (loaded with createRequire from apps/api; the same
//     pure checker the API runs at start-up) and every entry is checked against the schema;
//   - every `.rawRead(market, '<id>', ...)` call names a literal id of the list, from the
//     infrastructure folder of the module that owns the entry;
//   - C3: raw SQL members (`$queryRaw`, `$executeRaw` and their Unsafe/Typed forms) and the
//     `pg` driver are used only by the files in RAW_SQL_FILES; everywhere else, a read goes
//     through the RawReadPort.
//
// Usage: node scripts/check-prisma-boundaries.mjs [schema-dir] [--src <apps/api/src>]
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { readPrismaSchema } from './prisma-schema.mjs';

/** The tables reserved to platform/persistence/outbox/ (P 9, the named exception). */
const OUTBOX_TABLES = ['outbox', 'inbox'];
/** Tables whose ADR-0006 key leads with the UUIDv7 event id instead of marketId (P 9). */
const EVENT_KEYED_TABLES = ['inbox', 'event_delivery'];
const OUTBOX_FOLDER = 'platform/persistence/outbox/';
/** The platform tables reserved to platform/persistence/audit/ (the AuditWriter). */
const AUDIT_TABLES = ['audit_log', 'audit_log_seal', 'audit_chain_checkpoint'];
const AUDIT_FOLDER = 'platform/persistence/audit/';
/** The calls whose result is a model view: `PrismaService.tx(market)` and `auditTx(market)`. */
const VIEW_CALLS = ['tx', 'auditTx'];

/** C3: the only files (relative to the source root) that may run raw SQL (Hassan L-4). */
const RAW_SQL_FILES = new Set([
  'platform/persistence/advisory-job-lock.ts',
  'platform/persistence/database-probe.ts',
  'platform/persistence/guarded-client.ts',
  'platform/persistence/market-guard.ts',
  'platform/persistence/named-statements.ts',
  'platform/persistence/outbox/in-process-event-bus.ts',
  'platform/persistence/outbox/prisma-event-dispatcher.ts',
  'platform/persistence/outbox/prisma-outbox-relay.ts',
  // The PostgreSQL store of rate-limiter-flexible sends its own fixed statements (identity design 13).
  'platform/persistence/postgres-rate-limit-counters.ts',
  'platform/persistence/prisma-root.ts',
  'platform/persistence/prisma-unit-of-work.ts',
  'platform/persistence/raw-reads/prisma-raw-read-port.ts',
]);
/** C3: the only files that may import the database driver (ADR-0030 decision 6). */
const DRIVER_FILES = new Set(['platform/persistence/prisma-root.ts']);
const DRIVER_SPECIFIER = /^(pg|pg-[^/]+|postgres|@prisma\/adapter-pg)(\/.*)?$/;
const RAW_SQL_MEMBER =
  /^\$(queryRaw|executeRaw|queryRawUnsafe|executeRawUnsafe|queryRawTyped|extends)$/;
const PRISMA_RAW_BUILDERS = new Set(['sql', 'raw', 'join']);
const RAW_READS_FOLDER = 'platform/persistence/raw-reads/';

const args = process.argv.slice(2);
const srcFlag = args.indexOf('--src');
const srcDir = path.resolve(srcFlag >= 0 ? args[srcFlag + 1] : 'apps/api/src');
const positional = args.filter(
  (arg, index) => !arg.startsWith('--') && args[index - 1] !== '--src',
);
const schemaDir = path.resolve(positional[0] ?? 'prisma/schema');

const { models, enums, problems } = readPrismaSchema(schemaDir);
const byName = new Map(models.map((model) => [model.name, model]));
const isScoped = (model) => model.hasMarketId && model.hasTenantId;

// --- Module schemas (ADR-0004 decision 2).
for (const block of [...models.map((m) => ({ ...m, kind: 'model' })), ...enums]) {
  const expectedSchema = path.basename(block.file, '.prisma').replaceAll('-', '_');
  if (block.file === 'base.prisma') {
    problems.push(`${block.file}: ${block.kind} ${block.name} must live in its module's own file`);
  } else if (block.schema === undefined) {
    problems.push(
      `${block.file}: ${block.kind} ${block.name} has no @@schema("${expectedSchema}")`,
    );
  } else if (block.schema !== expectedSchema) {
    problems.push(
      `${block.file}: ${block.kind} ${block.name} is in schema "${block.schema}", but this file ` +
        `owns "${expectedSchema}"`,
    );
  }
}

for (const model of models) {
  // --- No relation crosses a module schema.
  for (const field of model.fields.filter((f) => f.relation)) {
    const target = byName.get(field.type);
    if (target.schema !== model.schema) {
      problems.push(
        `${model.file}: ${model.name}.${field.name} relates to ${field.type} in schema ` +
          `"${target.schema}". Relations may not cross module schemas; store the id as a plain column.`,
      );
    }
  }

  // --- Scope (P 4.2).
  if (model.hasMarketId !== model.hasTenantId) {
    problems.push(
      `${model.file}: ${model.name} has ${model.hasMarketId ? 'marketId without tenantId' : 'tenantId without marketId'}`,
    );
  } else if (isScoped(model) && model.exemptionReason !== undefined) {
    problems.push(
      `${model.file}: ${model.name} has marketId and tenantId and also an exemption line`,
    );
  } else if (!isScoped(model) && model.exemptionReason === undefined) {
    problems.push(
      `${model.file}: ${model.name} is neither market-scoped (marketId and tenantId) nor exempt ` +
        '("/// @market-scope none: <reason>")',
    );
  }

  // --- Unique keys of a scoped model contain marketId (P 9, PM6).
  if (isScoped(model)) {
    for (const key of model.keys) {
      if (key.fields.includes('marketId')) continue;
      const field = model.fields.find((f) => f.name === key.fields[0]);
      const uuidId =
        key.kind === 'id' &&
        key.single &&
        field?.type === 'String' &&
        field.attributes.some((a) => a.name === 'db.Uuid');
      const eventKey = EVENT_KEYED_TABLES.includes(model.table) && key.fields[0] === 'eventId';
      if (!uuidId && !eventKey) {
        const label = key.single
          ? `@${key.kind} on ${key.fields[0]}`
          : `@@${key.kind}([${key.fields.join(', ')}])`;
        problems.push(`${model.file}: ${model.name} ${label} does not contain marketId`);
      }
    }
  }

  // --- A relation between scoped models carries marketId on both sides, aligned (PM6).
  for (const relation of model.relations) {
    const target = byName.get(relation.target);
    if (!target) continue;
    // An exempt model and a scoped model never relate, in either direction: the guard reads
    // no Market on the exempt side, so a relation would carry rows across Markets.
    if (isScoped(model) !== isScoped(target)) {
      problems.push(
        `${model.file}: ${model.name}.${relation.field} relates ` +
          `${isScoped(model) ? 'a market-scoped' : 'an exempt'} model to ` +
          `${isScoped(target) ? 'the market-scoped' : 'the exempt'} model ${target.name}; ` +
          'exempt and market-scoped models may not relate',
      );
      continue;
    }
    if (!isScoped(model)) continue;
    const from = relation.fields.indexOf('marketId');
    const to = relation.references.indexOf('marketId');
    if (from < 0 || to < 0) {
      problems.push(
        `${model.file}: ${model.name}.${relation.field} relates two market-scoped models without ` +
          'marketId in both fields and references (PM6)',
      );
    } else if (from !== to) {
      problems.push(
        `${model.file}: ${model.name}.${relation.field} pairs marketId with another column ` +
          '(marketId is at different positions in fields and references; PM6)',
      );
    }
  }
}

// --- Every outbox has the same fields (PM1).
const outboxes = models.filter((model) => model.table === 'outbox');
const shape = (model) =>
  JSON.stringify(
    model.fields.map((f) => [f.name, f.type, f.list, f.optional, f.attributes]).sort(),
  );
for (const model of outboxes.slice(1)) {
  if (shape(model) !== shape(outboxes[0])) {
    problems.push(
      `${model.file}: ${model.name} is an outbox whose fields differ from ${outboxes[0].name}`,
    );
  }
}

// --- Model to owning module (P 9).
if (existsSync(srcDir)) problems.push(...checkModelOwnership(srcDir));

if (existsSync(srcDir)) problems.push(...(await checkRawReads(srcDir)));

if (problems.length > 0) {
  console.error(
    `Prisma boundary violations:\n${problems.map((problem) => `  - ${problem}`).join('\n')}`,
  );
  process.exit(1);
}
console.log(`Prisma boundaries hold (${models.length} model(s) checked).`);

/** The owning module of a source file, or undefined when the rule does not look at it. */
function moduleOfFile(relative) {
  const inModule = /^modules\/([^/]+)\/infrastructure\//.exec(relative);
  if (inModule) return inModule[1];
  if (relative.startsWith('platform/persistence/')) return 'platform';
  return undefined;
}

function sourceFiles(dir) {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.(ts|mts|cts)$/.test(entry.name))
    .filter((entry) => !/\.spec\.(ts|mts|cts)$/.test(entry.name))
    .map((entry) => path.join(entry.parentPath, entry.name))
    .sort();
}

function checkModelOwnership(root) {
  const found = [];
  const byClientProperty = new Map(models.map((model) => [model.clientProperty, model]));
  // Longest name first, so `AuditLogEntry` is not read as `AuditLog` + `Entry`.
  const names = models.map((model) => model.name).sort((a, b) => b.length - a.length);
  const modelOfTypeName = (name) =>
    names.find(
      (model) =>
        name === model || (name.startsWith(model) && /^[A-Z_]/.test(name.slice(model.length))),
    );
  const isGenerated = (specifier) => /(^|\/)generated\/prisma(\/|$)/.test(specifier);

  for (const file of sourceFiles(root)) {
    const relative = path.relative(root, file).split(path.sep).join('/');
    const owner = moduleOfFile(relative);
    if (owner === undefined) continue;
    const inOutboxFolder = relative.startsWith(OUTBOX_FOLDER);
    const inAuditFolder = relative.startsWith(AUDIT_FOLDER);
    const source = ts.createSourceFile(
      file,
      readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
    const lineOf = (node) => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;

    const report = (node, model, how) => {
      const reserved = OUTBOX_TABLES.includes(model.table);
      const audit = model.module === 'platform' && AUDIT_TABLES.includes(model.table);
      const allowed = reserved ? inOutboxFolder : audit ? inAuditFolder : model.module === owner;
      if (allowed) return;
      const why = reserved
        ? `is reserved to ${OUTBOX_FOLDER} (write it through OutboxWriter)`
        : audit
          ? `is reserved to ${AUDIT_FOLDER} (write it through AuditWriter)`
          : `belongs to module "${model.module}"`;
      found.push(`${relative}:${lineOf(node)}: ${how} names model ${model.name}, which ${why}`);
    };

    /** Whether `node` is a `tx(...)` or `auditTx(...)` call, under any parentheses. */
    const isViewCall = (node) => {
      while (node && ts.isParenthesizedExpression(node)) node = node.expression;
      if (!node || !ts.isCallExpression(node)) return false;
      const callee = node.expression;
      const name = ts.isIdentifier(callee)
        ? callee.text
        : ts.isPropertyAccessExpression(callee)
          ? callee.name.text
          : undefined;
      return VIEW_CALLS.includes(name);
    };
    const reportComputed = (node) =>
      found.push(
        `${relative}:${lineOf(node)}: a computed key on a tx(...) result hides the model it ` +
          'names; name the model as a property',
      );

    const visit = (node) => {
      if (ts.isPropertyAccessExpression(node)) {
        const model = byClientProperty.get(node.name.text);
        if (model) report(node.name, model, `property ".${node.name.text}"`);
        if (ts.isIdentifier(node.expression) && node.expression.text === 'Prisma') {
          const name = modelOfTypeName(node.name.text);
          if (name) report(node.name, byName.get(name), `"Prisma.${node.name.text}"`);
        }
      } else if (
        ts.isElementAccessExpression(node) &&
        ts.isStringLiteralLike(node.argumentExpression)
      ) {
        const model = byClientProperty.get(node.argumentExpression.text);
        if (model)
          report(node.argumentExpression, model, `property ["${node.argumentExpression.text}"]`);
      } else if (ts.isElementAccessExpression(node) && isViewCall(node.expression)) {
        reportComputed(node.argumentExpression);
      } else if (ts.isObjectBindingPattern(node)) {
        const initializer = ts.isVariableDeclaration(node.parent)
          ? node.parent.initializer
          : undefined;
        for (const element of node.elements) {
          const key = element.propertyName ?? element.name;
          const literal =
            ts.isComputedPropertyName(key) && ts.isStringLiteralLike(key.expression)
              ? key.expression
              : key;
          if (ts.isIdentifier(literal) || ts.isStringLiteralLike(literal)) {
            const model = byClientProperty.get(literal.text);
            if (model) report(literal, model, `destructured property "${literal.text}"`);
          } else if (ts.isComputedPropertyName(literal) && isViewCall(initializer)) {
            reportComputed(literal);
          }
        }
      } else if (
        ts.isQualifiedName(node) &&
        ts.isIdentifier(node.left) &&
        node.left.text === 'Prisma'
      ) {
        const name = modelOfTypeName(node.right.text);
        if (name) report(node.right, byName.get(name), `type "Prisma.${node.right.text}"`);
      } else if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier) &&
        isGenerated(node.moduleSpecifier.text)
      ) {
        const specifier = node.moduleSpecifier.text;
        const fromModels = /generated\/prisma\/models\/(\w+)$/.exec(specifier);
        if (fromModels && byName.has(fromModels[1])) {
          report(node.moduleSpecifier, byName.get(fromModels[1]), `import "${specifier}"`);
        }
        const bindings = ts.isImportDeclaration(node)
          ? node.importClause?.namedBindings
          : node.exportClause;
        const elements = bindings && 'elements' in bindings ? bindings.elements : [];
        for (const element of elements) {
          const imported = (element.propertyName ?? element.name).text;
          const name = modelOfTypeName(imported);
          if (name) report(element, byName.get(name), `import of "${imported}"`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return found;
}

/**
 * Transpiles the pure checker (always the repository's own, so a fixture cannot swap it) and
 * the list under `root`, and imports them from a temp dir.
 */
async function loadRawReadChecker(root) {
  const checkerFolder = path.resolve('apps/api/src', RAW_READS_FOLDER);
  const dir = mkdtempSync(path.join(tmpdir(), 'raw-reads-'));
  try {
    for (const name of ['statements', 'statement-check', 'raw-read-list-check']) {
      const folder = name === 'statements' ? path.join(root, RAW_READS_FOLDER) : checkerFolder;
      const out = ts
        .transpileModule(readFileSync(path.join(folder, `${name}.ts`), 'utf8'), {
          compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
        })
        .outputText.replace(/(from\s+['"]\.\/[^'"]+)(['"])/g, '$1.mjs$2');
      writeFileSync(path.join(dir, `${name}.mjs`), out);
    }
    const list = await import(pathToFileURL(path.join(dir, 'raw-read-list-check.mjs')).href);
    const statements = await import(pathToFileURL(path.join(dir, 'statements.mjs')).href);
    return { check: list.checkRawReadList, entries: statements.RAW_READ_STATEMENTS };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function checkRawReads(root) {
  const found = [];
  let entries = [];
  if (existsSync(path.join(root, RAW_READS_FOLDER, 'statements.ts'))) {
    // The parser belongs to apps/api (Ali's ruling C-e); the root script reaches it from there.
    const apiRequire = createRequire(path.resolve('apps/api/package.json'));
    const { loadModule, parse } = apiRequire('libpg-query');
    await loadModule();
    const loaded = await loadRawReadChecker(root);
    entries = loaded.entries;
    const problemsOfList = await loaded.check(parse, entries, rawReadModelMap());
    found.push(...problemsOfList.map((line) => `raw read statement ${line}`));
  }
  const ids = new Map(entries.map((entry) => [entry.id, entry]));

  for (const file of sourceFiles(root)) {
    const relative = path.relative(root, file).split(path.sep).join('/');
    const source = ts.createSourceFile(
      file,
      readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
    const lineOf = (node) => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
    const rawSqlAllowed = RAW_SQL_FILES.has(relative);
    const owner = /^modules\/([^/]+)\/infrastructure\//.exec(relative)?.[1];
    const driverAllowed = DRIVER_FILES.has(relative);
    const rawSqlMessage = (node) =>
      `${relative}:${lineOf(node)}: raw SQL outside the files of RAW_SQL_FILES; ` +
      'read through RawReadPort (ADR-0030)';
    const visit = (node) => {
      if (!rawSqlAllowed) {
        if (ts.isPropertyAccessExpression(node)) {
          const onPrisma = ts.isIdentifier(node.expression) && node.expression.text === 'Prisma';
          if (
            RAW_SQL_MEMBER.test(node.name.text) ||
            (onPrisma && PRISMA_RAW_BUILDERS.has(node.name.text))
          ) {
            found.push(rawSqlMessage(node));
          }
        } else if (
          ts.isElementAccessExpression(node) &&
          ts.isStringLiteralLike(node.argumentExpression) &&
          RAW_SQL_MEMBER.test(node.argumentExpression.text)
        ) {
          found.push(rawSqlMessage(node));
        } else if (ts.isBindingElement(node)) {
          const key = node.propertyName ?? node.name;
          const literal = ts.isComputedPropertyName(key) ? key.expression : key;
          const text =
            ts.isIdentifier(literal) || ts.isStringLiteralLike(literal) ? literal.text : undefined;
          if (text !== undefined && RAW_SQL_MEMBER.test(text)) found.push(rawSqlMessage(node));
        }
      }
      if (!driverAllowed) {
        let specifier;
        if (
          (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
          node.moduleSpecifier &&
          ts.isStringLiteral(node.moduleSpecifier)
        ) {
          specifier = node.moduleSpecifier.text;
        } else if (
          ts.isImportEqualsDeclaration(node) &&
          ts.isExternalModuleReference(node.moduleReference) &&
          ts.isStringLiteralLike(node.moduleReference.expression)
        ) {
          specifier = node.moduleReference.expression.text;
        } else if (
          ts.isCallExpression(node) &&
          (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
            (ts.isIdentifier(node.expression) && node.expression.text === 'require')) &&
          node.arguments[0] &&
          ts.isStringLiteralLike(node.arguments[0])
        ) {
          specifier = node.arguments[0].text;
        }
        if (
          ts.isCallExpression(node) &&
          (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
            (ts.isIdentifier(node.expression) && node.expression.text === 'require')) &&
          !(node.arguments[0] && ts.isStringLiteralLike(node.arguments[0]))
        ) {
          found.push(
            `${relative}:${lineOf(node)}: require/import() needs a string literal specifier ` +
              '(a computed one could load the database driver; ADR-0030)',
          );
        }
        if (specifier !== undefined && DRIVER_SPECIFIER.test(specifier)) {
          found.push(
            `${relative}:${lineOf(node)}: import of the database driver "${specifier}" ` +
              'outside the files of DRIVER_FILES (ADR-0030)',
          );
        }
      }
      if (!relative.startsWith(RAW_READS_FOLDER)) {
        const isCallee =
          ts.isPropertyAccessExpression(node) &&
          node.name.text === 'rawRead' &&
          ts.isCallExpression(node.parent) &&
          node.parent.expression === node;
        if (isCallee) {
          const call = node.parent;
          const id = call.arguments[1];
          if (id === undefined || !ts.isStringLiteralLike(id)) {
            found.push(
              `${relative}:${lineOf(call)}: rawRead needs a string literal statement id as its second argument`,
            );
          } else if (!ids.has(id.text)) {
            found.push(
              `${relative}:${lineOf(call)}: rawRead names "${id.text}", which is not in the list`,
            );
          } else if (ids.get(id.text).owner !== owner) {
            found.push(
              `${relative}:${lineOf(call)}: rawRead "${id.text}" belongs to module ` +
                `"${ids.get(id.text).owner}"; call it from that module's infrastructure folder`,
            );
          }
        } else if (
          (ts.isPropertyAccessExpression(node) && node.name.text === 'rawRead') ||
          (ts.isElementAccessExpression(node) &&
            ts.isStringLiteralLike(node.argumentExpression) &&
            node.argumentExpression.text === 'rawRead') ||
          (ts.isBindingElement(node) && (node.propertyName ?? node.name).text === 'rawRead')
        ) {
          found.push(
            `${relative}:${lineOf(node)}: rawRead must be called directly as .rawRead(market, '<id>', ...)`,
          );
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return found;
}

/** The part of the model map the list check reads, from the models this run already parsed. */
function rawReadModelMap() {
  const mapModels = {};
  const mapModules = {};
  for (const model of models) {
    if (model.schema === undefined) continue;
    mapModels[model.name] = { module: model.module, schema: model.schema, table: model.table };
    mapModules[model.module] = { schema: model.module.replaceAll('-', '_') };
  }
  return { models: mapModels, modules: mapModules };
}
