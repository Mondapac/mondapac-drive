// The local Market configuration of `pnpm dev:seed` and the CI smoke run: config/ plus the
// synthetic ZZ fixtures of test/fixtures/, copied to .dev/config/ (git-ignored), with each empty
// admin and courier `allowedOrigins` list filled with the origin of that population's link pages
// (the value the panel and the app are expected to configure; AU keeps its lists empty until the
// real hosts are known). DEV_ADMIN_ORIGINS adds origins to every admin list (comma-separated,
// for a panel on http://localhost:<port>). Never used by a deployed stack: config/ is untouched.
//
// `node scripts/dev-config.mjs` writes the folders and prints the variables the API needs,
// one KEY=value per line, for `export $(node scripts/dev-config.mjs)` or `>> "$GITHUB_ENV"`.
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Writes .dev/config and answers the environment the API and the seed read it from. */
export function writeDevConfig(env = process.env) {
  const target = path.join(root, '.dev/config');
  const extraAdmin = (env.DEV_ADMIN_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  const kinds = {
    markets: 'MARKET_CONFIG_DIR',
    'service-areas': 'SERVICE_AREA_CONFIG_DIR',
    locales: 'LOCALE_CONFIG_DIR',
  };
  const out = {};
  for (const [kind, variable] of Object.entries(kinds)) {
    const directory = path.join(target, kind);
    rmSync(directory, { recursive: true, force: true });
    mkdirSync(directory, { recursive: true });
    for (const source of [
      path.join(root, 'config', kind),
      path.join(root, 'test/fixtures', kind),
    ]) {
      for (const entry of readdirSync(source, { withFileTypes: true })) {
        const from = path.join(source, entry.name);
        if (entry.isDirectory()) copyTree(from, path.join(directory, entry.name));
        else if (entry.name.endsWith('.json')) {
          const text = readFileSync(from, 'utf8');
          writeFileSync(
            path.join(directory, entry.name),
            kind === 'markets'
              ? `${JSON.stringify(withOrigins(JSON.parse(text), extraAdmin), null, 2)}\n`
              : text,
          );
        }
      }
    }
    out[variable] = directory;
  }
  // Courier documents and proof photos; the API and the seed must share it.
  out.OBJECT_STORE_DIR = env.OBJECT_STORE_DIR ?? path.join(root, '.object-store');
  return out;
}

function withOrigins(market, extraAdmin) {
  for (const population of ['admin', 'courier']) {
    const list = market.allowedOrigins[population];
    if (list.length === 0) {
      const pages = Object.values(market.identity.links.targets[population] ?? {});
      for (const origin of new Set(pages.map((page) => new URL(page).origin))) list.push(origin);
    }
  }
  for (const origin of extraAdmin) {
    if (!market.allowedOrigins.admin.includes(origin)) market.allowedOrigins.admin.push(origin);
  }
  return market;
}

function copyTree(from, to) {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    if (entry.isDirectory()) copyTree(source, target);
    else writeFileSync(target, readFileSync(source));
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  for (const [key, value] of Object.entries(writeDevConfig()))
    process.stdout.write(`${key}=${value}\n`);
}
