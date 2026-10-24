// Built-parser check (ADR-0030, Ali's ruling C-g): after `pnpm build`, the built API must load
// the pinned `libpg-query` through its only importer, platform/persistence/raw-reads/pg-parser,
// and the parser must speak PostgreSQL 17, refuse a syntax error and split statements.
//
// Usage: node scripts/check-built-parser.mjs   (run by `pnpm build`)
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = path.join(root, 'apps/api/dist/platform/persistence/raw-reads/pg-parser.js');
const problems = [];

try {
  const { parseSql } = createRequire(file)(file);
  const one = await parseSql('SELECT 1');
  if (one.version !== 170007)
    problems.push(`the parser reports version ${one.version}, not 170007`);
  if ((await parseSql('SELECT 1; SELECT 2')).stmts.length < 2) {
    problems.push('a two-statement text did not yield two statements');
  }
  await parseSql('SELEC 1').then(
    () => problems.push('a syntax error was accepted'),
    () => undefined,
  );
} catch (error) {
  problems.push(`the built parser did not load: ${error.message}`);
}

if (problems.length > 0) {
  console.error(`Built-parser check failed:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  process.exit(1);
}
console.log('Built parser loads (libpg-query, PostgreSQL 17).');
