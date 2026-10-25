// `pnpm smoke:courier --market AU|ZZ [--api <url>]`: runs `pnpm --filter courier smoke` as the
// courier `pnpm dev:seed` made, on the delivery the seed assigned to them (.dev/seed/<id>.json),
// against a running local API (default http://localhost:3100). The run records the delivery
// as delivered, so it works once per seed; seed a fresh database to run it again.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? undefined : args[index + 1];
};
const market = flag('market');
if (market === undefined || !/^[A-Z]{2}$/.test(market)) {
  process.stderr.write('usage: courier-smoke --market <id> [--api <url>]\n');
  process.exit(1);
}
const seed = JSON.parse(readFileSync(path.join(root, '.dev/seed', `${market}.json`), 'utf8'));
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const run = spawnSync(pnpm, ['--filter', 'courier', 'smoke'], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: {
    ...process.env,
    SMOKE_API_URL: flag('api') ?? 'http://localhost:3100',
    SMOKE_MARKET_ID: market,
    SMOKE_COURIER_EMAIL: seed.courier.email,
    SMOKE_COURIER_PASSWORD: seed.courier.password,
    SMOKE_DELIVERY_ID: seed.assignedDelivery.deliveryId,
    SMOKE_DELIVERY_PIN: seed.assignedDelivery.pin,
  },
});
process.exit(run.status ?? 1);
