import type { PrismaRoot } from '../prisma-root';
import type { ModelMap } from '../model-map';
import { assertRawReadList } from './raw-read-list-check';
import { PrismaRawReadPort } from './prisma-raw-read-port';
import type { ParseSql } from './statement-check';
import type { RawReadEntry } from './statements';

/**
 * The start-up of the port (ADR-0030 decision 4): the list is re-checked with the pure parse
 * before the port exists, so the application refuses to start on a statement that breaks
 * decisions 2 to 5 or when the parser cannot load. Dependencies are passed in so a test can
 * prove the refusal through the same function the module calls.
 */
export async function createRawReadPort(
  root: PrismaRoot,
  deps: { parse: ParseSql; list: readonly RawReadEntry[]; map: ModelMap },
): Promise<PrismaRawReadPort> {
  await assertRawReadList(deps.parse, deps.list, deps.map);
  return new PrismaRawReadPort(root, deps.list);
}
