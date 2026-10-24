// Panel boundaries (marketplace ADR-0034 decisions 8 and 9). Run by `pnpm boundaries`, so by `pnpm verify`
// and CI. Reads the import and export specifiers of apps/panel, packages/ui and packages/panel-server:
//   - the panel imports neither apps/api (@mondapac-drive/api) nor another app;
//   - packages/ui imports no app and not apps/api;
//   - the panels use the shared kernel through its main entry only, and only its value types:
//     never ActorContext, CallContext or the minted-context types (server-side, ADR-0020);
//   - no relative import leaves its package.
//
// Usage: node scripts/check-panel-boundaries.mjs [repo-root]
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const root = path.resolve(process.argv[2] ?? path.join(import.meta.dirname, '..'));
const PACKAGES = ['apps/panel', 'packages/ui', 'packages/panel-server'];
const SERVER_ONLY_KERNEL_NAMES = new Set([
  'ActorContext',
  'AnonymousActor',
  'AuthenticatedActor',
  'SystemActor',
  'CallContext',
  'MarketContext',
  'mintMarketContext',
  'anonymousActor',
  'systemActor',
  'authenticatedActor',
  'createCallContext',
]);
const SKIP_DIRS = new Set(['node_modules', '.next', 'dist', 'coverage']);

function* sourceFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* sourceFiles(full);
    else if (/\.(ts|tsx|mts|mjs|js|cjs)$/.test(entry.name) && entry.name !== 'next-env.d.ts')
      yield full;
  }
}

/** Specifiers of a file with the names each import takes (null when it takes none by name). */
function importsOf(file, text) {
  const kind = file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
  const found = [];
  const visit = (node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const clause = ts.isImportDeclaration(node)
        ? node.importClause?.namedBindings
        : node.exportClause;
      const names =
        clause && (ts.isNamedImports(clause) || ts.isNamedExports(clause))
          ? clause.elements.map((e) => (e.propertyName ?? e.name).text)
          : null;
      found.push({ specifier: node.moduleSpecifier.text, names });
    } else if (
      ts.isImportExpression?.(node) ||
      (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword)
    ) {
      const arg = node.arguments[0];
      found.push({
        specifier: arg && ts.isStringLiteral(arg) ? arg.text : '<computed>',
        names: null,
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

const violations = [];
for (const pkg of PACKAGES) {
  const pkgDir = path.join(root, pkg);
  if (!existsSync(pkgDir)) continue;
  const isUi = pkg === 'packages/ui';
  const self = `@mondapac-drive/${path.basename(pkg)}`;
  for (const file of sourceFiles(pkgDir)) {
    const rel = path.relative(root, file);
    for (const { specifier, names } of importsOf(file, readFileSync(file, 'utf8'))) {
      const fail = (rule) => violations.push(`${rel}: ${rule} (imports '${specifier}')`);
      if (specifier === '<computed>') fail('imports-are-static: no computed import()');
      if (/^@mondapac-drive\/api(\/|$)/.test(specifier)) fail('panels never import apps/api');
      if (/^@mondapac-drive\/(panel|courier)(\/|$)/.test(specifier) && (isUi || specifier !== self))
        fail(isUi ? 'packages/ui imports no app' : 'an app never imports another app');
      if (isUi && /^@mondapac-drive\/panel-server(\/|$)/.test(specifier))
        fail('packages/ui imports no server-only package');
      if (specifier.startsWith('.')) {
        const target = path.resolve(path.dirname(file), specifier);
        if (path.relative(pkgDir, target).startsWith('..'))
          fail('a relative import never leaves its package');
      }
      if (specifier.startsWith('@mondapac-drive/shared-kernel')) {
        if (specifier !== '@mondapac-drive/shared-kernel')
          fail('the shared kernel is used through its main entry only');
        else if (names === null) fail('import the shared kernel by name, value types only');
        else
          for (const name of names)
            if (SERVER_ONLY_KERNEL_NAMES.has(name)) fail(`'${name}' is a server-side kernel type`);
      }
    }
  }
}

if (violations.length > 0) {
  console.error(`Panel boundaries: ${violations.length} violation(s)\n${violations.join('\n')}`);
  process.exit(1);
}
console.log('Panel boundaries: ok');
