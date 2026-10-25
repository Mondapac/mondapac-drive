import 'reflect-metadata';
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { hostname, userInfo } from 'node:os';
import path from 'node:path';
import type { Clock } from '@mondapac-drive/shared-kernel';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { AddressInfo } from 'node:net';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { databaseAccepted } from './check-database-role';
import { APP_OPTIONS, configureApp } from './configure-app';
import { DEV_SEED_COMMANDS } from './dev-seed/dev-seed-commands';
import { devSeedRefusal, dropOutboundProviders } from './dev-seed/guard';
import { SeedMailCatcher } from './dev-seed/mail-catcher';
import {
  SeedAlreadyRunError,
  seedMarket,
  type SeedData,
  type SeedDocumentRule,
} from './dev-seed/seed-market';
import { loadEnvFile } from './load-env-file';
import { CLOCK } from './platform/clock/clock.module';
import { InvalidConfigError, loadAppConfig } from './platform/config/app-config';
import { runOperatorCommand } from './platform/operator/operator-command';
import { DatabaseProbe } from './platform/persistence/database-probe';
import { WorkerRuntime } from './platform/worker/worker-runtime';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const USAGE =
  'usage: dev-seed --market <id> [--samples <n>] [--out <file>]  ' +
  '(NODE_ENV development or test, a database ending in _dev or _test)';
/** The password of the seeded admin and courier: long enough for every Market's policy. */
const DEV_PASSWORD = 'mondapac-drive-dev-seed-password';

/**
 * `pnpm dev:seed --market AU|ZZ` (handoff 35; scripts/dev-seed.mjs builds and calls this):
 * fills an empty local database with a Market's first admin, a merchant with an API key, an
 * approved courier who can go online, one delivery assigned to that courier and sample
 * deliveries, all through the real HTTP routes and use cases, never SQL. It refuses to run
 * unless NODE_ENV is development or test and the database name ends in _dev or _test.
 *
 * One process boots the application with both roles' loops (HTTP on a loopback port, the relay,
 * dispatcher and scheduler), so the roles get seeded and mails sent while it runs; mails go to
 * an in-process catcher. The credentials are written to `--out` (default `.dev/seed/<id>.json`,
 * git-ignored) and never to the log. Exit 0 done, 1 refused or failed, 2 already seeded.
 */
async function main(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);
  if (args === null) {
    process.stderr.write(`${USAGE}\n`);
    return 1;
  }
  loadEnvFile();
  const refusal = devSeedRefusal(process.env);
  if (refusal !== null) {
    process.stderr.write(`dev-seed refused: ${refusal}\n`);
    return 1;
  }
  const data = readJson<SeedData>(
    path.join(REPO_ROOT, 'scripts/dev-seed/markets', `${args.market}.json`),
  );
  const routingKeys = readRoutingKeyVariables(process.env.MARKET_CONFIG_DIR, args.market);
  dropOutboundProviders(process.env, routingKeys);
  const mail = await SeedMailCatcher.start();
  const config = {
    ...loadAppConfig({ ...process.env, APP_ROLE: 'api', MAIL_CATCHER_URL: mail.url }),
  };
  if (!config.hostedMarkets.includes(args.market as never)) {
    process.stderr.write(`dev-seed refused: HOSTED_MARKETS does not list ${args.market}\n`);
    await mail.close();
    return 1;
  }
  const market = readMarketFile(config.marketConfigDirs, args.market);

  const app = await NestFactory.create<NestExpressApplication>(
    AppModule.register({ config }),
    APP_OPTIONS,
  );
  app.useLogger(app.get(Logger));
  configureApp(app);
  const runtime = app.get(WorkerRuntime);
  try {
    if (!(await databaseAccepted(app.get(DatabaseProbe), app.get(Logger)))) return 1;
    await app.listen(0, '127.0.0.1');
    await runtime.start();
    const { port } = app.getHttpServer().address() as AddressInfo;
    const clock = app.get<Clock>(CLOCK, { strict: false });
    const operator = { osUser: userInfo().username, host: hostname() };
    const outcome = await seedMarket({
      baseUrl: `http://127.0.0.1:${port}`,
      marketId: args.market,
      adminOrigin: originOf(market.identity.links.targets.admin),
      data,
      documents: market.fleet.documents,
      mail,
      now: () => clock.now().epochMilliseconds,
      samples: args.samples,
      password: DEV_PASSWORD,
      operator: async (commandArgv) => {
        let body: Record<string, unknown> = {};
        const exit = await runOperatorCommand(
          app,
          DEV_SEED_COMMANDS,
          commandArgv,
          operator,
          (line) => Promise.resolve(void process.stderr.write(`${line}\n`)),
          (line) => {
            body = line.startsWith('{')
              ? (JSON.parse(line) as Record<string, unknown>)
              : { outcome: line };
          },
          USAGE,
        );
        return { exit, body };
      },
    });
    const out = path.resolve(args.out ?? path.join(REPO_ROOT, '.dev/seed', `${args.market}.json`));
    // Owner-only, also when --out names an existing file (Hassan L2): a fresh file, renamed in.
    mkdirSync(path.dirname(out), { recursive: true, mode: 0o700 });
    chmodSync(path.dirname(out), 0o700);
    const fresh = `${out}.${process.pid}.tmp`;
    writeFileSync(fresh, `${JSON.stringify(outcome, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    chmodSync(fresh, 0o600);
    renameSync(fresh, out);
    process.stdout.write(
      `dev-seed: ${args.market} seeded; credentials in ${path.relative(process.cwd(), out)}\n`,
    );
    return 0;
  } catch (error) {
    if (error instanceof SeedAlreadyRunError) {
      process.stderr.write(`dev-seed: ${error.message}\n`);
      return 2;
    }
    throw error;
  } finally {
    await runtime.stop();
    await app.close();
    await mail.close();
  }
}

interface SeedArgs {
  readonly market: string;
  readonly samples: number;
  readonly out: string | undefined;
}

function parseArgs(argv: readonly string[]): SeedArgs | null {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === undefined || !flag.startsWith('--') || value === undefined) return null;
    values.set(flag.slice(2), value);
  }
  const market = values.get('market');
  const samples = Number(values.get('samples') ?? '2');
  const known = [...values.keys()].every((key) => ['market', 'samples', 'out'].includes(key));
  if (!known || market === undefined || !/^[A-Z]{2}$/.test(market)) return null;
  if (!Number.isInteger(samples) || samples < 0 || samples > 20) return null;
  return { market, samples, out: values.get('out') };
}

interface MarketFile {
  readonly identity: {
    readonly links: { readonly targets: { readonly admin: Record<string, string> } };
  };
  readonly fleet: { readonly documents: readonly SeedDocumentRule[] };
}

function readMarketFile(directories: readonly string[], market: string): MarketFile {
  for (const directory of directories) {
    try {
      return readJson<MarketFile>(path.join(directory, `${market}.json`));
    } catch {
      // The next directory.
    }
  }
  throw new Error(`no ${market}.json in the Market configuration directories`);
}

/** The admin panel's origin: the origin of the admin link pages. */
function originOf(pages: Record<string, string>): string {
  const first = Object.values(pages)[0];
  if (first === undefined) throw new Error('the Market has no admin link pages');
  return new URL(first).origin;
}

/**
 * Every routing key variable the Market configuration names (`routing.<provider>.apiKeyEnv`),
 * so the seed drops them with the other outbound providers.
 */
function readRoutingKeyVariables(directory: string | undefined, market: string): string[] {
  const directories = [directory ?? path.join(REPO_ROOT, 'config/markets')];
  try {
    const file = readMarketFile(directories, market) as { routing?: unknown };
    return [...JSON.stringify(file.routing ?? {}).matchAll(/"apiKeyEnv":"([A-Z][A-Z0-9_]*)"/g)].map(
      (match) => match[1]!,
    );
  } catch {
    return [];
  }
}

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, 'utf8')) as T;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    // Codes and routes only (SeedRequestError), never a body, a token or a URL with a password.
    process.stderr.write(
      `dev-seed failed: ${error instanceof InvalidConfigError || error instanceof Error ? error.message : 'unknown error'}\n`,
    );
    process.exit(1);
  },
);
