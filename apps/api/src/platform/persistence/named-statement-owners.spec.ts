import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// P 4.2: a named statement is "<module>.<name>" and only that module's files may call it. The
// list is checked in (named-statements.ts); this reads every `namedQuery` call under
// src/modules and refuses one that names another module's statement, or a name that is not a
// string literal the check can read. It is a tripwire for the direct call form only
// (`namedQuery(market, 'm.x', ...)`); an indirect form (`.call`, `['namedQuery']`) is for code
// review and the security review of any new statement (named-statements.ts).

const MODULES = join(__dirname, '../../modules');
const CALL = /namedQuery\s*(?:<[^>]*>)?\s*\(\s*[^,]+,\s*(['"`])([^'"`]*)\1/gu;
const ANY_CALL = /namedQuery\s*(?:<[^>]*>)?\s*\(/gu;

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.ts$/u.test(name) && !/\.(spec|db-spec)\.ts$/u.test(name) ? [path] : [];
  });
}

describe('named statements belong to one module each', () => {
  const files = readdirSync(MODULES)
    .filter((name) => statSync(join(MODULES, name)).isDirectory())
    .flatMap((module) => sourceFiles(join(MODULES, module)).map((file) => ({ module, file })));

  it('finds the module files it checks', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files.map(({ module, file }) => [module, file.slice(MODULES.length + 1)]))(
    'module %s: %s calls only its own statements, by literal name',
    (module, relative) => {
      const text = readFileSync(join(MODULES, relative), 'utf8');
      const literal = [...text.matchAll(CALL)];
      const all = [...text.matchAll(ANY_CALL)];
      expect(literal.length).toBe(all.length);
      for (const match of literal) {
        expect(match[2]!.startsWith(`${module}.`)).toBe(true);
      }
    },
  );
});
