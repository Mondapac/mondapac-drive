import type { ModelMap } from '../model-map';
import { checkStatement, type ParseSql, type StatementOwner } from './statement-check';
import type { RawReadEntry } from './statements';

const ID = /^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/;
const SCALAR = new Set(['uuid', 'text']);
/** The largest array cap a statement may declare; a larger one is a deliberate, reviewed change. */
const MAX_ARRAY_CAP = 1000;

/** The owner's schema and tables, read from the generated model map (models only, no view). */
export function ownerOf(map: ModelMap, owner: string): StatementOwner | null {
  const module = map.modules[owner];
  if (module === undefined) return null;
  const tables = Object.values(map.models)
    .filter((model) => model.module === owner && model.schema === module.schema)
    .map((model) => model.table);
  return { schema: module.schema, tables: new Set(tables) };
}

/**
 * Re-checks the whole list with the same pure parse as the boundary script (decision 4): list
 * rules (id, owner, parameter declarations, duplicates) and the statement check per entry.
 * Returns `<id>: <code>` lines; empty when the list is sound. Pure but for the parser.
 */
export async function checkRawReadList(
  parse: ParseSql,
  list: readonly RawReadEntry[],
  map: ModelMap,
): Promise<string[]> {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const entry of list) {
    const bad = (code: string): number => problems.push(`${entry.id}: ${code}`);
    if (!ID.test(entry.id) || entry.id.split('.')[0] !== entry.owner) bad('id-not-owner-name');
    if (seen.has(entry.id)) bad('duplicate-id');
    seen.add(entry.id);
    if (entry.reason.trim() === '' || entry.design.trim() === '') bad('reason-or-design-missing');
    const names = new Set<string>();
    const groupLengths = new Map<string, number>();
    for (const param of entry.params) {
      if (names.has(param.name)) bad('duplicate-param');
      names.add(param.name);
      const array = param.type.endsWith('[]');
      if (!array && !SCALAR.has(param.type)) bad('param-type');
      if (array && (param.maxLength === undefined || param.maxLength < 1)) bad('array-cap-missing');
      if (array && !SCALAR.has(param.type.slice(0, -2))) bad('param-type');
      if (array && param.maxLength !== undefined && param.maxLength > MAX_ARRAY_CAP) {
        bad('array-cap-too-large');
      }
      if (!array && (param.maxLength !== undefined || param.group !== undefined)) {
        bad('scalar-with-array-options');
      }
      if (param.group !== undefined && param.maxLength !== undefined) {
        const cap = groupLengths.get(param.group);
        if (cap !== undefined && cap !== param.maxLength) bad('group-caps-differ');
        groupLengths.set(param.group, param.maxLength);
      }
    }
    const owner = ownerOf(map, entry.owner);
    if (owner === null) {
      bad('unknown-owner');
      continue;
    }
    for (const code of await checkStatement(parse, entry, owner)) bad(code);
  }
  return problems;
}

/** Throws when the list breaks decisions 2 to 5; the application then refuses to start. */
export async function assertRawReadList(
  parse: ParseSql,
  list: readonly RawReadEntry[],
  map: ModelMap,
): Promise<void> {
  // A canary first: a parser that cannot load stops the start even for an empty list.
  await parse('SELECT 1');
  const problems = await checkRawReadList(parse, list, map);
  if (problems.length > 0) {
    throw new Error(`raw read statement list violates ADR-0030: ${problems.join('; ')}`);
  }
}
