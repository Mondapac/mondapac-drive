// `pnpm dev:seed --market AU|ZZ [--samples <n>] [--out <file>]`: build the shared kernel and the
// API, write the local Market configuration (scripts/dev-config.mjs), then run the built seed
// entry (apps/api/src/dev-seed.ts), which refuses unless NODE_ENV is development or test and the
// database name ends in _dev or _test. Start the API with the same variables
// (`export $(node scripts/dev-config.mjs)`) so it accepts the seeded Market. Plain Node, so it
// works the same in pnpm on Windows, macOS and Linux. See docs/runbooks/dev-seed.md.
import { spawnSync } from 'node:child_process';
import { writeDevConfig } from './dev-config.mjs';

const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const options = { stdio: 'inherit', shell: process.platform === 'win32' };

if (process.env.DEV_SEED_SKIP_BUILD !== '1') {
  for (const filter of ['@mondapac-drive/shared-kernel', '@mondapac-drive/api']) {
    const build = spawnSync(pnpm, ['--filter', filter, 'build'], options);
    if (build.status !== 0) process.exit(build.status ?? 1);
  }
}

const seed = spawnSync(process.execPath, ['apps/api/dist/dev-seed', ...process.argv.slice(2)], {
  stdio: 'inherit',
  // The application's info lines would bury the seed's own output; LOG_LEVEL still wins.
  env: { LOG_LEVEL: 'warn', ...process.env, ...writeDevConfig() },
});
process.exit(seed.status ?? 1);
