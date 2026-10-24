// The only file that imports `libpg-query` (ADR-0030, Ali's ruling C-e): the PostgreSQL
// parser as WASM, used on the static text of the raw read list at start-up and by
// `scripts/check-prisma-boundaries.mjs`. Never on caller input, never per request.
import { loadModule, parse } from 'libpg-query';
import type { ParseSql } from './statement-check';

let loaded: Promise<void> | null = null;

/**
 * The parser, loaded once. A load failure rejects every call (and is retried on the next
 * call), so a caller that cannot parse refuses to start rather than skipping the check.
 */
export const parseSql: ParseSql = async (sql) => {
  loaded ??= loadModule().catch((error: unknown) => {
    loaded = null;
    throw error;
  });
  await loaded;
  return (await parse(sql)) as Awaited<ReturnType<ParseSql>>;
};
