// Copies MapLibre's worker and the module it imports into public/maplibre/<version>/ unchanged
// (Drive live map). The bundler renames the worker's sibling module, so a bundled worker cannot
// load; served as they ship, the worker's `./maplibre-gl-shared.mjs` import resolves. Run by
// `dev` and `build`; the copy is not committed.
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = path.dirname(fileURLToPath(import.meta.resolve('maplibre-gl')));
const { version } = JSON.parse(readFileSync(path.join(dist, '..', 'package.json'), 'utf8'));
const target = path.join(import.meta.dirname, '..', 'public', 'maplibre', version);
mkdirSync(target, { recursive: true });
for (const file of ['maplibre-gl-worker.mjs', 'maplibre-gl-shared.mjs']) {
  copyFileSync(path.join(dist, file), path.join(target, file));
}
console.log(JSON.stringify({ msg: 'panel.maplibre-worker.copied', version }));
