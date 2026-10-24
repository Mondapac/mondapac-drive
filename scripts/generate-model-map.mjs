// The model map generator (platform persistence design, "P", section 9). It runs as a Prisma
// generator (`generator modelMap` in prisma/schema/base.prisma), so every `prisma generate`
// (`pnpm db:generate`, `postinstall`, `pnpm db:migrate:dev`) rewrites
// apps/api/src/generated/model-map.ts beside the generated client, git-ignored like it.
//
// The map is read from prisma/schema/*.prisma by the parser the boundaries check uses
// (scripts/prisma-schema.mjs). On every run it is compared with Prisma's own DMMF: models,
// scalar and relation fields, the single-column ids and the compound unique selectors must be
// the same, or generation fails. Three readers use the map: the market guard (P 4), the
// outbox writer and relay (slice 1b), and the PM6 database test.
//
// Usage:
//   as a Prisma generator: nothing to do, `prisma generate` starts it
//   by hand:  node scripts/generate-model-map.mjs [--schema prisma/schema] [--json | --out <file>]
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { readPrismaSchema } from './prisma-schema.mjs';

const DEFAULT_OUTPUT = 'apps/api/src/generated/model-map.ts';

/** Thrown when the schema cannot be mapped; the message lists every problem. */
export class ModelMapError extends Error {}

/**
 * The map of a schema directory. A model is `scoped` when it has both `marketId` and
 * `tenantId`, `exempt` when it carries the `/// @market-scope none: <reason>` line; a model
 * with neither, or both, or only one of the two columns, fails (P 4.2).
 */
export function buildModelMap(schemaDir) {
  const schema = readPrismaSchema(schemaDir);
  const problems = [...schema.problems];
  const byName = new Map(schema.models.map((model) => [model.name, model]));
  const scopeOf = (model) => {
    const columns = model.hasMarketId && model.hasTenantId;
    if (model.hasMarketId !== model.hasTenantId) {
      problems.push(`${model.file}: ${model.name} has only one of marketId and tenantId`);
      return undefined;
    }
    if (columns && model.exemptionReason !== undefined) {
      problems.push(`${model.file}: ${model.name} has marketId and tenantId and an exemption line`);
      return undefined;
    }
    if (!columns && model.exemptionReason === undefined) {
      problems.push(
        `${model.file}: ${model.name} has neither marketId and tenantId nor a ` +
          '"/// @market-scope none: <reason>" line',
      );
      return undefined;
    }
    return columns ? 'scoped' : 'exempt';
  };

  const models = {};
  for (const model of schema.models) {
    const scope = scopeOf(model);
    const singleId = model.keys.find((key) => key.kind === 'id' && key.single);
    const columnOf = (target, field) =>
      byName.get(target)?.fields.find((f) => f.name === field)?.column ?? field;
    models[model.name] = {
      module: model.module,
      schema: model.schema ?? null,
      table: model.table,
      clientProperty: model.clientProperty,
      scope: scope ?? 'invalid',
      scalarFields: model.fields.filter((f) => !f.relation).map((f) => f.name),
      relationFields: model.fields.filter((f) => f.relation).map((f) => f.name),
      idField: singleId ? singleId.fields[0] : null,
      compoundSelectors: model.keys
        .filter((key) => !key.single)
        .map((key) => ({ name: key.name, fields: key.fields })),
      foreignKeys: model.relations.map((relation) => ({
        field: relation.field,
        target: relation.target,
        targetTable: byName.get(relation.target)?.table ?? relation.target,
        fields: relation.fields,
        references: relation.references,
        columns: relation.fields.map((field) => columnOf(model.name, field)),
        referencedColumns: relation.references.map((field) => columnOf(relation.target, field)),
      })),
    };
  }

  const modules = {};
  for (const file of schema.files.filter((name) => name !== 'base.prisma')) {
    const module = path.basename(file, '.prisma');
    const owned = schema.models.filter((model) => model.module === module);
    const byTable = (table) => owned.find((model) => model.table === table)?.name ?? null;
    modules[module] = {
      schema: module.replaceAll('-', '_'),
      outboxModel: byTable('outbox'),
      inboxModel: byTable('inbox'),
    };
  }

  if (problems.length > 0) throw new ModelMapError(problems.join('\n'));
  return { models, modules };
}

/** The checked comparison with Prisma's DMMF (`generate` request of the generator protocol). */
export function compareWithDmmf(map, dmmf) {
  const problems = [];
  const sorted = (values) => [...values].sort();
  const same = (a, b) => JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));
  const dmmfModels = dmmf.datamodel.models;
  if (
    !same(
      Object.keys(map.models),
      dmmfModels.map((m) => m.name),
    )
  ) {
    problems.push('the models differ from the DMMF');
  }
  for (const model of dmmfModels) {
    const entry = map.models[model.name];
    if (entry === undefined) continue;
    const fieldsOf = (kind) => model.fields.filter((f) => f.kind === kind).map((f) => f.name);
    if (!same(entry.relationFields, fieldsOf('object'))) {
      problems.push(`${model.name}: relation fields differ from the DMMF`);
    }
    if (!same(entry.scalarFields, [...fieldsOf('scalar'), ...fieldsOf('enum')])) {
      problems.push(`${model.name}: scalar fields differ from the DMMF`);
    }
    const dmmfId = model.fields.find((f) => f.isId)?.name ?? null;
    if (entry.idField !== dmmfId)
      problems.push(`${model.name}: the id field differs from the DMMF`);
    const selector = (key) => `${key.name ?? key.fields.join('_')}(${key.fields.join(',')})`;
    const dmmfSelectors = [
      ...(model.primaryKey && model.primaryKey.fields.length > 1 ? [model.primaryKey] : []),
      ...model.uniqueIndexes.filter((key) => key.fields.length > 1),
    ].map(selector);
    if (!same(entry.compoundSelectors.map(selector), dmmfSelectors)) {
      problems.push(`${model.name}: compound unique selectors differ from the DMMF`);
    }
    for (const fk of entry.foreignKeys) {
      const field = model.fields.find((f) => f.name === fk.field);
      if (
        JSON.stringify(field?.relationFromFields ?? []) !== JSON.stringify(fk.fields) ||
        JSON.stringify(field?.relationToFields ?? []) !== JSON.stringify(fk.references)
      ) {
        problems.push(`${model.name}.${fk.field}: relation keys differ from the DMMF`);
      }
    }
  }
  if (problems.length > 0) {
    throw new ModelMapError(
      `The model map parser disagrees with Prisma (fix scripts/prisma-schema.mjs):\n` +
        problems.join('\n'),
    );
  }
}

/** The generated TypeScript file. Types live in apps/api/src/platform/persistence/model-map.ts. */
export function renderModelMap(map) {
  return [
    '/* Generated by scripts/generate-model-map.mjs from prisma/schema. Do not edit. */',
    '/* eslint-disable */',
    '// Platform persistence design, section 9: the model map read by the market guard,',
    '// the outbox writer and relay, and the PM6 database test.',
    `export const MODEL_MAP = ${JSON.stringify(map, null, 2)} as const;`,
    '',
  ].join('\n');
}

function write(file, map) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, renderModelMap(map));
}

/** The JSON-RPC protocol Prisma speaks with a generator: requests on stdin, answers on stderr. */
function serveGeneratorProtocol() {
  const answer = (message) => process.stderr.write(`${JSON.stringify(message)}\n`);
  createInterface({ input: process.stdin }).on('line', (line) => {
    const request = JSON.parse(line);
    try {
      if (request.method === 'getManifest') {
        answer({
          jsonrpc: '2.0',
          id: request.id,
          result: {
            manifest: {
              prettyName: 'Model map',
              defaultOutput: path.resolve(DEFAULT_OUTPUT),
              requiresEngines: [],
            },
          },
        });
      } else if (request.method === 'generate') {
        const { schemaPath, generator, dmmf } = request.params;
        const map = buildModelMap(schemaPath);
        compareWithDmmf(map, dmmf);
        write(generator.output?.value ?? path.resolve(DEFAULT_OUTPUT), map);
        answer({ jsonrpc: '2.0', id: request.id, result: null });
      }
    } catch (error) {
      answer({
        jsonrpc: '2.0',
        id: request.id,
        error: { code: -32000, message: error.message, data: null },
      });
    }
  });
}

function runFromCommandLine(argv) {
  const option = (name) => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  try {
    const map = buildModelMap(path.resolve(option('--schema') ?? 'prisma/schema'));
    if (argv.includes('--json')) process.stdout.write(`${JSON.stringify(map, null, 2)}\n`);
    else write(path.resolve(option('--out') ?? DEFAULT_OUTPUT), map);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  if (process.env.PRISMA_GENERATOR_INVOCATION === 'true') serveGeneratorProtocol();
  else runFromCommandLine(process.argv.slice(2));
}
