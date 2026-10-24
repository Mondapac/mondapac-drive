// Built-kernel check (platform-foundations design 3.7 and its section 13 note): after
// `pnpm build`, the API must load ONE build of the shared kernel through its four
// entries, `@mondapac-drive/shared-kernel`, `/testing`, `/contexts` (slice 1c) and
// `/authenticated-actor` (identity slice 2). Minted
// contexts are recorded in a module-private WeakSet, so a second copy of the kernel in
// one process would make every context from the other copy fail `isMinted`.
//
// It checks resolution from the API package, that a context minted through the `/testing`
// builders passes `isMinted` from the main entry, (slice 0 item 3b) that the built API's own
// `platform/` code, which loads the kernel from `apps/api/dist`, accepts such a context and
// refuses a copy, and (item 4) that the kernel's package exports refuse a deep import from
// apps/api: no file of the kernel is reachable at run time except through its entries.
//
// Usage: node scripts/check-built-kernel.mjs   (run by `pnpm build`)
import { existsSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fromApi = createRequire(path.join(root, 'apps/api/package.json'));
// The built platform code that attaches a request's MarketContext after an isMinted check.
const platformFile = path.join(
  root,
  'apps/api/dist/platform/market-context/attached-market-context.js',
);
// Both market fixtures (ADR-0003 decision 9): the launch Market and the synthetic one.
const markets = ['AU', 'ZZ'];
const problems = [];

let kernelDist;
try {
  kernelDist = realpathSync(path.join(root, 'packages/shared-kernel/dist')) + path.sep;
} catch {
  console.error(
    'Built-kernel check failed: packages/shared-kernel/dist is missing (run pnpm build).',
  );
  process.exit(1);
}

// The `/contexts` entry (identity slice 1c) holds the actor and call-context constructors.
const entries = [
  '@mondapac-drive/shared-kernel',
  '@mondapac-drive/shared-kernel/testing',
  '@mondapac-drive/shared-kernel/contexts',
  // The authenticated-actor constructor (identity slice 2), for identity's Authenticator.
  '@mondapac-drive/shared-kernel/authenticated-actor',
];
// Deep imports that the kernel's `exports` map must refuse: a file of its build output, and
// the minting module by a subpath. pnpm boundaries refuses them in the source as well.
const deepImports = [
  '@mondapac-drive/shared-kernel/dist/minted.js',
  '@mondapac-drive/shared-kernel/minted',
];
const resolved = new Map();
for (const entry of entries) {
  try {
    const file = realpathSync(fromApi.resolve(entry));
    resolved.set(entry, file);
    if (!file.startsWith(kernelDist)) {
      problems.push(`${entry} resolves outside the kernel's dist/: ${path.relative(root, file)}`);
    }
  } catch (error) {
    problems.push(`${entry} does not resolve from apps/api: ${error.code ?? error.message}`);
  }
}

for (const deepImport of deepImports) {
  try {
    fromApi(deepImport);
    problems.push(`${deepImport} loads from apps/api: the kernel's exports must refuse it`);
  } catch (error) {
    if (error.code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') {
      problems.push(
        `${deepImport} failed with ${error.code ?? error.message}, not ERR_PACKAGE_PATH_NOT_EXPORTED`,
      );
    }
  }
}

if (problems.length === 0) {
  try {
    const kernel = fromApi('@mondapac-drive/shared-kernel');
    const testing = fromApi('@mondapac-drive/shared-kernel/testing');
    const contexts = fromApi('@mondapac-drive/shared-kernel/contexts');
    const authenticated = fromApi('@mondapac-drive/shared-kernel/authenticated-actor');
    for (const market of markets) {
      const context = testing.testMarketContext(market, 'mondapac');
      if (!kernel.isMinted(context)) {
        problems.push(
          `a ${market} context minted through /testing fails isMinted from the main entry`,
        );
      }
      // An actor and a call context built through /contexts from a /testing market context:
      // one WeakSet across the three entries.
      const call = contexts.createCallContext(
        context,
        contexts.systemActor(context),
        'built-kernel-check-0001',
      );
      if (!kernel.isMinted(call) || !kernel.isMinted(call.actor)) {
        problems.push(`a ${market} call context built through /contexts fails isMinted`);
      }
      // An authenticated actor built through its own entry, in a call context of /contexts.
      const actor = authenticated.authenticatedActor(context, {
        population: 'customer',
        accountId: '01900000-0000-7000-8000-000000000001',
        sessionId: '01900000-0000-7000-8000-000000000002',
        sellerId: null,
      });
      const signedIn = contexts.createCallContext(context, actor, 'built-kernel-check-0002');
      if (!kernel.isMinted(actor) || !kernel.isMinted(signedIn)) {
        problems.push(`a ${market} authenticated actor fails isMinted across the entries`);
      }
    }
  } catch (error) {
    problems.push(`minting through /testing threw: ${error.message}`);
  }
}

if (problems.length === 0 && !existsSync(platformFile)) {
  problems.push(`${path.relative(root, platformFile)} is missing (run pnpm build)`);
}

if (problems.length === 0) {
  try {
    const fromPlatform = createRequire(platformFile);
    const kernelOfPlatform = realpathSync(fromPlatform.resolve('@mondapac-drive/shared-kernel'));
    if (kernelOfPlatform !== resolved.get('@mondapac-drive/shared-kernel')) {
      problems.push(
        `apps/api/dist/platform loads another kernel build: ${path.relative(root, kernelOfPlatform)}`,
      );
    }

    const platform = fromPlatform(platformFile);
    const testing = fromApi('@mondapac-drive/shared-kernel/testing');
    for (const market of markets) {
      const context = testing.testMarketContext(market, 'mondapac');
      const request = {};
      platform.attachMarketContext(request, context); // throws unless isMinted there
      if (platform.marketContextOf(request) !== context) {
        problems.push(`apps/api/dist/platform returned another ${market} context than attached`);
      }

      // The negative control: without it a platform check that accepted anything would pass.
      for (const forgery of [{ ...context }, { marketId: market, tenantId: 'mondapac' }]) {
        try {
          platform.attachMarketContext({}, forgery);
          problems.push(`apps/api/dist/platform accepted an unminted ${market} context`);
        } catch (error) {
          if (!(error instanceof TypeError)) throw error;
        }
      }
    }
  } catch (error) {
    problems.push(`a /testing context fails the check in apps/api/dist/platform: ${error.message}`);
  }
}

if (problems.length > 0) {
  console.error('Built-kernel check failed:');
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
console.log(
  `Built-kernel check passed: ${[...resolved.values()]
    .map((file) => path.relative(root, file))
    .join(', ')} load one build of the shared kernel; ` +
    `/testing contexts (${markets.join(', ')}) pass isMinted in apps/api/dist/platform; ` +
    `${deepImports.join(' and ')} are refused with ERR_PACKAGE_PATH_NOT_EXPORTED.`,
);
