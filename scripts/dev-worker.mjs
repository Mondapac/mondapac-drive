// `pnpm dev:worker`: build the shared kernel and the API once, then run the built API as the
// worker role (APP_ROLE=worker, P 8). No watcher: `nest start --watch` deletes dist on every
// build, so a second watcher beside `pnpm dev` would race it. Restart this after a code change.
// Plain Node, so the environment variable works the same in pnpm on Windows, macOS and Linux.
import { spawn, spawnSync } from 'node:child_process';

const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const options = { stdio: 'inherit', shell: process.platform === 'win32' };

for (const filter of ['@mondapac-drive/shared-kernel', '@mondapac-drive/api']) {
  const build = spawnSync(pnpm, ['--filter', filter, 'build'], options);
  if (build.status !== 0) process.exit(build.status ?? 1);
}

const worker = spawn(process.execPath, ['apps/api/dist/main'], {
  stdio: 'inherit',
  env: { ...process.env, APP_ROLE: 'worker' },
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => worker.kill(signal));
worker.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
