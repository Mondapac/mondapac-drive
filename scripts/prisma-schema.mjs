// The one reader of prisma/schema/*.prisma used by the scripts (platform persistence design,
// "P" below, section 9): `check-prisma-boundaries.mjs` checks the schema with it and
// `generate-model-map.mjs` writes the model map from it. It reads the subset of the Prisma
// schema language this repository uses: `model` and `enum` blocks, `///` documentation, field
// attributes and block attributes on one line each. Prisma itself stays the authority on the
// language: the generator compares what this parser found with Prisma's DMMF on every
// `prisma generate` and fails on any difference.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

/** The documentation line that exempts a model from the market scope (P 4.2). */
export const MARKET_SCOPE_EXEMPTION = /^@market-scope none:\s*(\S.*)$/;

/** Removes a `//` comment that is not a `///` documentation line, outside string literals. */
function stripComment(line) {
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '\\' && quoted) index += 1;
    else if (char === '"') quoted = !quoted;
    else if (!quoted && char === '/' && line[index + 1] === '/') {
      return line.slice(0, index);
    }
  }
  return line;
}

/** Splits `text` at top-level commas, outside brackets, parentheses and strings. */
function splitTopLevel(text) {
  const parts = [];
  let depth = 0;
  let quoted = false;
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '\\' && quoted) index += 1;
    else if (char === '"') quoted = !quoted;
    else if (quoted) continue;
    else if (char === '[' || char === '(') depth += 1;
    else if (char === ']' || char === ')') depth -= 1;
    else if (char === ',' && depth === 0) {
      parts.push(text.slice(start, index).trim());
      start = index + 1;
    }
  }
  const last = text.slice(start).trim();
  if (last !== '') parts.push(last);
  return parts;
}

/** A value of an attribute argument: a list of names, a string, or a bare word. */
function parseValue(raw) {
  const text = raw.trim();
  if (text.startsWith('[') && text.endsWith(']')) {
    // `[a, b(sort: Desc)]`: the field names, without their modifiers.
    return splitTopLevel(text.slice(1, -1)).map((item) => item.replace(/\(.*\)$/, '').trim());
  }
  if (text.startsWith('"') && text.endsWith('"')) return text.slice(1, -1);
  return text;
}

/** `(a, name: "x")` -> `{ positional: [a], named: { name: "x" } }`. */
function parseArguments(text) {
  const result = { positional: [], named: {} };
  if (text === undefined) return result;
  for (const part of splitTopLevel(text)) {
    const named = /^(\w+)\s*:\s*([\s\S]*)$/.exec(part);
    if (named && !part.startsWith('"') && !part.startsWith('[')) {
      result.named[named[1]] = parseValue(named[2]);
    } else {
      result.positional.push(parseValue(part));
    }
  }
  return result;
}

/** Every `@name(args)` of a field line, in order; nested parentheses are kept whole. */
function parseFieldAttributes(text) {
  const attributes = [];
  let index = 0;
  while (index < text.length) {
    const at = text.indexOf('@', index);
    if (at < 0) break;
    const name = /^@([\w.]+)/.exec(text.slice(at));
    if (!name) break;
    let end = at + name[0].length;
    let args;
    if (text[end] === '(') {
      let depth = 0;
      let quoted = false;
      for (let cursor = end; cursor < text.length; cursor += 1) {
        const char = text[cursor];
        if (char === '\\' && quoted) cursor += 1;
        else if (char === '"') quoted = !quoted;
        else if (quoted) continue;
        else if (char === '(') depth += 1;
        else if (char === ')' && --depth === 0) {
          args = text.slice(end + 1, cursor);
          end = cursor + 1;
          break;
        }
      }
    }
    attributes.push({ name: name[1], args: parseArguments(args) });
    index = end;
  }
  return attributes;
}

/**
 * Reads every `*.prisma` file of `schemaDir`. Returns the models and enums, each with the file
 * it was declared in, plus the problems the reader itself found (a block it cannot read).
 */
export function readPrismaSchema(schemaDir) {
  const files = readdirSync(schemaDir)
    .filter((name) => name.endsWith('.prisma'))
    .sort();
  const blocks = [];
  const problems = [];

  for (const file of files) {
    const lines = readFileSync(path.join(schemaDir, file), 'utf8').split(/\r?\n/);
    let documentation = [];
    for (let index = 0; index < lines.length; index += 1) {
      const line = stripComment(lines[index]).trim();
      const doc = /^\/\/\/\s?(.*)$/.exec(lines[index].trim());
      if (doc) {
        documentation.push(doc[1]);
        continue;
      }
      const opening = /^(model|enum|view|type|generator|datasource)\s+(\w+)\s*\{$/.exec(line);
      if (!opening) {
        if (line !== '') documentation = [];
        continue;
      }
      const [, kind, name] = opening;
      const body = [];
      let closed = false;
      for (index += 1; index < lines.length; index += 1) {
        if (stripComment(lines[index]).trim() === '}') {
          closed = true;
          break;
        }
        body.push(lines[index]);
      }
      if (!closed) problems.push(`${file}: ${kind} ${name} is not closed`);
      if (kind === 'model' || kind === 'enum' || kind === 'view' || kind === 'type') {
        blocks.push({ kind, name, file, documentation, body });
      }
      documentation = [];
    }
  }

  const modelNames = new Set(blocks.filter((b) => b.kind === 'model').map((b) => b.name));
  const models = [];
  const enums = [];
  for (const block of blocks) {
    if (block.kind !== 'model') {
      const schema = block.body
        .map((line) => /^\s*@@schema\("([^"]+)"\)/.exec(stripComment(line)))
        .find(Boolean)?.[1];
      enums.push({ kind: block.kind, name: block.name, file: block.file, schema });
      continue;
    }
    models.push(parseModel(block, modelNames));
  }
  return { files, models, enums, problems };
}

function parseModel(block, modelNames) {
  const fields = [];
  const blockAttributes = [];
  for (const raw of block.body) {
    const line = stripComment(raw).trim();
    if (line === '' || line.startsWith('///')) continue;
    const attribute = /^@@([\w.]+)(?:\(([\s\S]*)\))?$/.exec(line);
    if (attribute) {
      blockAttributes.push({ name: attribute[1], args: parseArguments(attribute[2]) });
      continue;
    }
    const field = /^(\w+)\s+([\w.]+)(\[\])?(\?)?(?:\s+(.*))?$/.exec(line);
    if (!field) continue;
    const [, name, type, list, optional, rest] = field;
    const attributes = parseFieldAttributes(rest ?? '');
    const mapped = attributes.find((a) => a.name === 'map')?.args.positional[0];
    fields.push({
      name,
      type,
      list: list !== undefined,
      optional: optional !== undefined,
      relation: modelNames.has(type),
      column: typeof mapped === 'string' ? mapped : name,
      attributes,
    });
  }

  const blockArg = (name) => blockAttributes.find((a) => a.name === name);
  const schema = blockArg('schema')?.args.positional[0];
  const table = blockArg('map')?.args.positional[0] ?? block.name;

  // Unique selectors, in Prisma's naming (P 4.1): `name:`, else the fields joined by `_`.
  const keys = [];
  for (const field of fields) {
    const id = field.attributes.find((a) => a.name === 'id');
    if (id) keys.push({ kind: 'id', fields: [field.name], name: field.name, single: true });
    if (field.attributes.some((a) => a.name === 'unique')) {
      keys.push({ kind: 'unique', fields: [field.name], name: field.name, single: true });
    }
  }
  for (const attribute of blockAttributes) {
    if (attribute.name !== 'id' && attribute.name !== 'unique') continue;
    const keyFields = attribute.args.named.fields ?? attribute.args.positional[0] ?? [];
    const list = Array.isArray(keyFields) ? keyFields : [keyFields];
    const explicit = attribute.args.named.name;
    keys.push({
      kind: attribute.name,
      fields: list,
      name: typeof explicit === 'string' ? explicit : list.join('_'),
      single: list.length === 1,
      named: typeof explicit === 'string',
    });
  }

  const relations = [];
  for (const field of fields.filter((f) => f.relation)) {
    const relation = field.attributes.find((a) => a.name === 'relation');
    const from = relation?.args.named.fields;
    const to = relation?.args.named.references;
    if (Array.isArray(from) && Array.isArray(to)) {
      relations.push({ field: field.name, target: field.type, fields: from, references: to });
    }
  }

  const exemption = block.documentation
    .map((line) => MARKET_SCOPE_EXEMPTION.exec(line.trim()))
    .find(Boolean);
  const has = (name) => fields.some((f) => f.name === name && !f.relation);
  return {
    name: block.name,
    file: block.file,
    module: path.basename(block.file, '.prisma'),
    schema,
    table,
    clientProperty: block.name.charAt(0).toLowerCase() + block.name.slice(1),
    documentation: block.documentation,
    exemptionReason: exemption?.[1],
    hasMarketId: has('marketId'),
    hasTenantId: has('tenantId'),
    fields,
    keys,
    relations,
    blockAttributes,
  };
}
