// @ts-check
import eslint from '@eslint/js';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import { panelSyntaxRules } from './packages/ui/lint/panel-rules.mjs';

// Market identifiers and the names of the places Drive serves must never appear as literals in
// core code: they belong in config/markets/ and config/service-areas/ (marketplace ADR-0001
// decision 5, ADR-0008 decision 6). Extend the list when a market or city is added.
const MARKET_OR_VERTICAL_LITERAL = '\\b(AU|AUD|en-AU|Brisbane|BRISBANE)\\b';
const noMarketOrVerticalLiterals = [
  {
    selector: `Literal[value=/${MARKET_OR_VERTICAL_LITERAL}/]`,
    message:
      'Market or vertical identifier hardcoded in core code. Move it to Market/Vertical configuration or a strategy implementation.',
  },
  {
    selector: `TemplateElement[value.raw=/${MARKET_OR_VERTICAL_LITERAL}/]`,
    message:
      'Market or vertical identifier hardcoded in core code. Move it to Market/Vertical configuration or a strategy implementation.',
  },
];

// Boundary rules of platform-foundations design 8.2 that ESLint enforces (rules 4, 5 and 7)
// and the attach rule of the slice 0 security review. `no-restricted-syntax` and
// `no-restricted-imports` carry no rule names of their own, so every message starts with the
// design's rule name. Deliberate violations in apps/api/test/boundary-fixtures/ are asserted
// by apps/api/test/boundaries.spec.ts.

// Rule 4, no-wall-clock: only platform/clock/ reads the wall clock (ADR-0005 decision 5).
const WALL_CLOCK = 'take the current time from the injected Clock; only platform/clock/ reads it.';
const noWallClock = [
  {
    selector: "NewExpression[callee.name='Date'][arguments.length=0]",
    message: `no-wall-clock: new Date() reads the wall clock: ${WALL_CLOCK}`,
  },
  {
    selector: "CallExpression[callee.name='Date']",
    message: `no-wall-clock: Date() reads the wall clock: ${WALL_CLOCK}`,
  },
  {
    selector: "CallExpression[callee.object.name='Date'][callee.property.name='now']",
    message: `no-wall-clock: Date.now() reads the wall clock: ${WALL_CLOCK}`,
  },
  {
    selector: "MemberExpression[object.name='Temporal'][property.name='Now']",
    message: `no-wall-clock: Temporal.Now reads the wall clock: ${WALL_CLOCK}`,
  },
];
// Rule 4, second part: domain/ and application/ use the kernel's Temporal types only; a
// repository converts an Instant with `new Date(value)` (design 3.2).
const noDateConversion = [
  {
    selector: "NewExpression[callee.name='Date'][arguments.length>0]",
    message:
      'no-wall-clock: no Date in domain/ or application/: use the Temporal types of the shared ' +
      'kernel. A repository in infrastructure/ converts with new Date(value).',
  },
];

// TypeScript sources of every kind: a block lints only the extensions it names, and
// boundaries.spec.ts checks that apps/api/src and the kernel's src hold no other kind.
const TS = '{ts,mts,cts}';
const SPEC_FILES = [`**/*.spec.${TS}`];
// The operations panel and the shared UI package also hold .tsx (marketplace ADR-0033, ADR-0034).
const PANEL_TSX = ['apps/panel/**/*.tsx', 'packages/ui/**/*.tsx'];
// The courier app (React Native, Expo) is written in .ts and .tsx.
const COURIER_TSX = ['apps/courier/**/*.tsx'];
// The fixture tree is outside the globs below, so each block names its fixture files too.
const FIXTURES = 'apps/api/test/boundary-fixtures';

/**
 * Forbids a name however it arrives: a named import (also renamed), a re-export, a member
 * of a namespace import (also computed with a literal), a qualified type name or a
 * destructured property. Matching the name rather than the import path also catches a
 * barrel.
 */
function forbidNames(names, message) {
  const name = `/^(${names.join('|')})$/`;
  return [
    `ImportSpecifier:matches([imported.name=${name}], [imported.value=${name}])`,
    `ExportSpecifier:matches([local.name=${name}], [local.value=${name}])`,
    `MemberExpression:matches([property.name=${name}], [property.value=${name}])`,
    `TSQualifiedName[right.name=${name}]`,
    `ObjectPattern > Property:matches([key.name=${name}], [key.value=${name}])`,
  ].map((selector) => ({ selector, message }));
}

// Rule 5, contexts-are-minted-by-platform (design 3.7): a module never mints a context and
// never asserts a value to a context type; it receives the context from its entry adapter.
// Slice 1 adds the actor and CallContext constructors and types; slice 2 adds the
// authenticated-actor constructor, which identity's Authenticator alone may call (the
// exemption block below; dependency-cruiser authenticated-actor-is-built-by-the-authenticator
// is the import check). Lint is a guard rail here: a literal can
// still reach a context parameter through `as any`, a type alias or an untyped value, so the
// run-time control is the kernel's isMinted check. The dependency-cruiser rule
// market-context-only-through-the-decorator closes the paths to the factory, and
// contextImportsOfModules closes namespace imports, `export *` and provider discovery.
const CONTEXT_CONSTRUCTORS = [
  'mintMarketContext',
  'MarketContextFactory',
  'anonymousActor',
  'systemActor',
  'createCallContext',
  'authenticatedActor',
];
const CONTEXT_TYPES = [
  'MarketContext',
  'ActorContext',
  'AnonymousActor',
  'SystemActor',
  'AuthenticatedActor',
  'CallContext',
];
const MINTED_BY_PLATFORM =
  'contexts-are-minted-by-platform: a module never mints a context; it receives one from ' +
  'its platform entry adapter.';
/** Rule 5's selectors, with the constructors in `allowed` left out (the Authenticator's block). */
const contextsAreMintedByPlatformExcept = (allowed) => [
  ...forbidNames(
    CONTEXT_CONSTRUCTORS.filter((name) => !allowed.includes(name)),
    MINTED_BY_PLATFORM,
  ),
  {
    selector: `:matches(TSAsExpression, TSTypeAssertion) > .typeAnnotation Identifier[name=/^(${CONTEXT_TYPES.join('|')})$/]`,
    message:
      'contexts-are-minted-by-platform: a module never asserts a value to a context type; a ' +
      'context is minted by the platform.',
  },
];
const contextsAreMintedByPlatform = contextsAreMintedByPlatformExcept([]);
// The same rule as import restrictions of the modules (a separate rule key, so the
// no-restricted-syntax blocks do not replace it). With importNames, a namespace import and
// an `export *` of the package are reported too. Provider discovery would hand a module the
// global factory without naming it.
const contextImportPaths = (entries) => [
  'error',
  {
    paths: [
      {
        name: '@mondapac-drive/shared-kernel',
        importNames: ['mintMarketContext'],
        message: MINTED_BY_PLATFORM,
      },
      ...entries.map((name) => ({ name, message: MINTED_BY_PLATFORM })),
      {
        name: '@nestjs/core',
        importNames: ['DiscoveryService', 'DiscoveryModule', 'ModulesContainer', 'ModuleRef'],
        message:
          'contexts-are-minted-by-platform: a module injects what it needs and never ' +
          "discovers providers, the platform's factory included.",
      },
    ],
  },
];
// The actor and CallContext constructors live in the kernel entry `contexts` and the
// authenticated-actor constructor in `authenticated-actor`. A path name match, so it holds
// whether or not the entry exists; a module imports the context types from the kernel main
// entry and never these entries. Identity's Authenticator alone imports the second one.
const contextImportsOfModules = contextImportPaths([
  '@mondapac-drive/shared-kernel/contexts',
  '@mondapac-drive/shared-kernel/authenticated-actor',
]);
const contextImportsOfTheAuthenticator = contextImportPaths([
  '@mondapac-drive/shared-kernel/contexts',
]);

// P 12.2 rule 4, no-raw-sql-or-transaction-in-modules: raw SQL and $transaction belong to the
// platform (UnitOfWork); a module reaches the database through the unit-of-work port. It is part
// of both module groups below, because a later block replaces the whole rule value.
const noRawSqlOrTransactionInModules = [
  {
    selector:
      'MemberExpression[property.name=/^\\$(queryRaw|executeRaw|queryRawUnsafe|executeRawUnsafe|queryRawTyped|transaction)$/]',
    message:
      'no-raw-sql-or-transaction-in-modules: Raw SQL and $transaction are platform-only (P 12.2 rule 4).',
  },
];

// Security review of slice 0: only MarketContextGuard attaches a request's MarketContext.
const onlyTheGuardAttaches = forbidNames(
  ['attachMarketContext'],
  'only-the-guard-attaches-market-context: attachMarketContext is called by ' +
    'MarketContextGuard only; read the Market with @Market().',
);

// Security review of slice 0 item 4 (M3), imports-are-static: code is loaded by a static
// import only, which pnpm boundaries sees. A computed import(), require, createRequire,
// process.mainModule and a direct eval (which sees the module's require) load code past every
// rule of this file and of dependency-cruiser.
const STATIC_IMPORTS =
  'imports-are-static: load code with a static import, so that pnpm boundaries sees it';
const codeLoaders = [
  { selector: "Identifier[name='require']", message: `${STATIC_IMPORTS} (no require).` },
  ...forbidNames(
    ['createRequire', 'mainModule'],
    `${STATIC_IMPORTS} (no createRequire or mainModule).`,
  ),
  { selector: "CallExpression[callee.name='eval']", message: `${STATIC_IMPORTS} (no eval).` },
];
const staticImportsOnly = [
  {
    selector: "ImportExpression[source.type!='Literal']",
    message: `${STATIC_IMPORTS} (no computed import()).`,
  },
  ...codeLoaders,
];
// Modules have no import() at all: the value of a dynamic import of the kernel, indexed with a
// computed name, would reach mintMarketContext past every name check of rule 5.
const moduleStaticImportsOnly = [
  {
    selector: 'ImportExpression',
    message:
      'imports-are-static: no import() in a module; import statically, so that the context ' +
      'rules see every name.',
  },
  ...codeLoaders,
];
// Rule 7 in the kernel: no import() at all, so the whitelist below cannot be passed by a
// dynamic import of a literal either.
const kernelStaticImportsOnly = [
  {
    selector: 'ImportExpression',
    message:
      'kernel-imports-only-itself: no import() in the shared kernel; import its own files statically.',
  },
  ...codeLoaders,
];

// Rule 7, kernel-imports-only-itself (ADR-0008 decision 1): a whitelist. The kernel imports
// only its own files (`./name`, never `..`); time.ts alone may also import the polyfill
// (ADR-0020 decision 7). Each regex matches what is refused.
const kernelImports = (regex) => [
  'error',
  {
    patterns: [
      {
        regex,
        message:
          'kernel-imports-only-itself: the shared kernel imports only its own files; time.ts ' +
          'alone may import temporal-polyfill. No Node API, package or framework.',
      },
    ],
  },
];

// Slice 1c, use-case-entry-is-the-gate (ADR-0018): UseCase.execute is the one entry that
// checks the access rule; a use case implements the protected `handle` and never overrides
// `execute` (application/use-cases/ only). Slice 2 (platform-foundations 8.3 W7 and W8) widens
// the `handle` group to every file of src/modules/, so a facade, a job or an event handler
// reaches a use case through execute too: no `handle` member on another object, no `handle`
// destructured, no 'handle' named to Reflect, and no reflection over a class's methods
// (`.prototype`, `__proto__`, Object.getPrototypeOf, Object.getOwnPropertyDescriptor(s)).
// `this.handle(` stays allowed (UseCase.execute is in platform/authz/, outside modules). A
// handler object in a module names its method something else.
const GATE = 'use-case-entry-is-the-gate';
const useCaseNeverOverridesExecute = {
  selector:
    "ClassBody > :matches(MethodDefinition, PropertyDefinition):matches([key.name='execute'], [key.value='execute'])",
  message: `${GATE}: a use case never overrides execute.`,
};
const HANDLE_ONLY_BY_EXECUTE = `${GATE}: handle is called only by UseCase.execute.`;
const handleIsReachedOnlyByExecute = [
  {
    // The member, not the call, so that x['handle'](), x.handle.call(...) and x.handle.bind(...)
    // are caught too.
    selector:
      "MemberExpression:matches([property.name='handle'], [property.value='handle'])[object.type!='ThisExpression']",
    message: HANDLE_ONLY_BY_EXECUTE,
  },
  {
    selector: "ObjectPattern > Property:matches([key.name='handle'], [key.value='handle'])",
    message: HANDLE_ONLY_BY_EXECUTE,
  },
  {
    selector:
      "CallExpression[callee.object.name='Reflect'] > :matches(Literal[value='handle'], TemplateLiteral > TemplateElement[value.raw='handle'])",
    message: HANDLE_ONLY_BY_EXECUTE,
  },
  {
    selector:
      'CallExpression:matches([callee.name=/^(getPrototypeOf|getOwnPropertyDescriptors?)$/], [callee.property.name=/^(getPrototypeOf|getOwnPropertyDescriptors?)$/])',
    message: `${GATE}: no reflection over a class's methods in a module (it reaches handle). Use Object.hasOwn, or a platform helper for plain-object checks; interceptors (CallHandler.handle) live in platform/.`,
  },
  {
    selector:
      'MemberExpression:matches([property.name=/^(prototype|__proto__)$/], [property.value=/^(prototype|__proto__)$/])',
    message: `${GATE}: no reflection over a class's methods in a module (it reaches handle). Use Object.hasOwn, or a platform helper for plain-object checks; interceptors (CallHandler.handle) live in platform/.`,
  },
];

// ADR-0037 decision 8, client-address-is-resolved-once: only platform/http/client-address.ts
// reads the socket's address; every other file reads the address it resolved (the socket, or
// the address a BFF proved). `no-restricted-properties` has one value per file, so the
// blocks below list the appRole entry next to it where both apply.
const APP_ROLE_IS_READ_IN_TWO_PLACES = {
  property: 'appRole',
  message:
    'app-role-is-read-in-two-places: only main.ts and platform/worker/ read appRole (P 12.2 rule 3).',
};
const CLIENT_ADDRESS_IS_RESOLVED_ONCE = {
  property: 'remoteAddress',
  message:
    'client-address-is-resolved-once: read the client address through ' +
    'platform/http/client-address.ts, never the socket (ADR-0037 decision 8).',
};
const CLIENT_ADDRESS_RESOLVER = [
  'apps/api/src/platform/http/client-address.ts',
  `${FIXTURES}/src/platform/http/client-address.ts`,
];

// The selector groups of the modules block and of the domain and application block.
const MODULE_SYNTAX = [
  ...noMarketOrVerticalLiterals,
  ...noWallClock,
  ...onlyTheGuardAttaches,
  ...contextsAreMintedByPlatform,
  ...noRawSqlOrTransactionInModules,
  ...moduleStaticImportsOnly,
  ...handleIsReachedOnlyByExecute,
];
const domainApplicationSyntax = (contextRules) => [
  ...noMarketOrVerticalLiterals,
  ...noWallClock,
  ...noDateConversion,
  ...onlyTheGuardAttaches,
  ...contextRules,
  ...noRawSqlOrTransactionInModules,
  ...moduleStaticImportsOnly,
  ...handleIsReachedOnlyByExecute,
];
const DOMAIN_APPLICATION_SYNTAX = domainApplicationSyntax(contextsAreMintedByPlatform);

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      // Next.js build output and the file Next generates in each panel app.
      '**/.next/**',
      '**/next-env.d.ts',
      '**/coverage/**',
      '**/node_modules/**',
      '**/generated/**',
      // Files the Expo CLI generates in the courier app.
      '**/.expo/**',
      // MapLibre's worker, copied unchanged by apps/panel/scripts/copy-maplibre-worker.mjs.
      'apps/panel/public/maplibre/**',
      // Deliberate violations used by apps/api/test/boundaries.spec.ts.
      '**/test/boundary-fixtures/**',
    ],
  },
  eslint.configs.recommended,
  {
    // No inline directive can switch a boundary rule off in the API sources (nothing there
    // uses one today). The kernel and the fixture trees are covered too.
    files: [
      `apps/api/src/**/*.${TS}`,
      `packages/shared-kernel/src/**/*.${TS}`,
      `${FIXTURES}/src/**/*.${TS}`,
      `${FIXTURES}/packages/shared-kernel/src/**/*.${TS}`,
    ],
    linterOptions: { noInlineConfig: true },
  },
  {
    files: [`**/*.${TS}`, ...PANEL_TSX, ...COURIER_TSX],
    extends: [...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  // no-restricted-syntax: a later block replaces the selectors of an earlier one, so each
  // block lists every group that applies to its files.
  {
    // All code of the API: the attach rule and static imports.
    files: [`apps/api/src/**/*.${TS}`, `${FIXTURES}/src/**/*.${TS}`],
    ignores: SPEC_FILES,
    rules: { 'no-restricted-syntax': ['error', ...onlyTheGuardAttaches, ...staticImportsOnly] },
  },
  {
    // The shared kernel.
    files: [
      `packages/shared-kernel/src/**/*.${TS}`,
      `${FIXTURES}/packages/shared-kernel/src/**/*.${TS}`,
    ],
    ignores: SPEC_FILES,
    rules: {
      'no-restricted-syntax': [
        'error',
        ...noMarketOrVerticalLiterals,
        ...noWallClock,
        ...kernelStaticImportsOnly,
      ],
    },
  },
  {
    // Platform runtime.
    files: [`**/src/platform/**/*.${TS}`],
    ignores: SPEC_FILES,
    rules: {
      'no-restricted-syntax': [
        'error',
        ...noMarketOrVerticalLiterals,
        ...noWallClock,
        ...onlyTheGuardAttaches,
        ...staticImportsOnly,
      ],
    },
  },
  {
    // The only reader of the wall clock.
    files: [`**/src/platform/clock/**/*.${TS}`],
    ignores: SPEC_FILES,
    rules: {
      'no-restricted-syntax': [
        'error',
        ...noMarketOrVerticalLiterals,
        ...onlyTheGuardAttaches,
        ...staticImportsOnly,
      ],
    },
  },
  {
    // The only file that attaches a request's MarketContext.
    files: ['**/src/platform/market-context/market-context.guard.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        ...noMarketOrVerticalLiterals,
        ...noWallClock,
        ...staticImportsOnly,
      ],
    },
  },
  {
    // Modules.
    files: [`**/src/modules/**/*.${TS}`],
    ignores: SPEC_FILES,
    rules: {
      'no-restricted-syntax': ['error', ...MODULE_SYNTAX],
      '@typescript-eslint/no-restricted-imports': contextImportsOfModules,
    },
  },
  {
    // P 12.2 rule 3, app-role-is-read-in-two-places: only main.ts and platform/worker/ read the
    // process role (APP_ROLE, P 8). Every other file receives behaviour, not the role.
    // ADR-0037 decision 8: and only the resolver reads the socket's address.
    files: [`apps/api/src/**/*.${TS}`, `${FIXTURES}/src/**/*.${TS}`],
    ignores: [
      ...SPEC_FILES,
      'apps/api/src/main.ts',
      'apps/api/src/platform/worker/**',
      `${FIXTURES}/src/main.ts`,
      `${FIXTURES}/src/platform/worker/**`,
    ],
    rules: {
      'no-restricted-properties': [
        'error',
        APP_ROLE_IS_READ_IN_TWO_PLACES,
        CLIENT_ADDRESS_IS_RESOLVED_ONCE,
      ],
    },
  },
  {
    // main.ts and platform/worker/ may read appRole, never the socket's address. Spec files
    // too: a test builds a request with an address, it does not read one.
    files: [
      'apps/api/src/main.ts',
      'apps/api/src/platform/worker/**',
      `${FIXTURES}/src/main.ts`,
      `${FIXTURES}/src/platform/worker/**`,
      `apps/api/src/**/*.spec.${TS}`,
    ],
    rules: { 'no-restricted-properties': ['error', CLIENT_ADDRESS_IS_RESOLVED_ONCE] },
  },
  {
    // The resolver alone reads the socket's address.
    files: CLIENT_ADDRESS_RESOLVER,
    rules: { 'no-restricted-properties': ['error', APP_ROLE_IS_READ_IN_TWO_PLACES] },
  },
  {
    // The domain and application layers of a module.
    files: [`**/src/modules/*/domain/**/*.${TS}`, `**/src/modules/*/application/**/*.${TS}`],
    ignores: SPEC_FILES,
    rules: {
      'no-restricted-syntax': ['error', ...DOMAIN_APPLICATION_SYNTAX],
    },
  },
  {
    // Use cases: the gate rule joins the domain and application list (a later block replaces
    // the selectors of an earlier one).
    files: [`**/src/modules/*/application/use-cases/**/*.${TS}`],
    ignores: SPEC_FILES,
    rules: {
      'no-restricted-syntax': ['error', ...DOMAIN_APPLICATION_SYNTAX, useCaseNeverOverridesExecute],
    },
  },
  {
    // Identity's Authenticator (identity design 6.2, slice 2): the one file that builds an
    // authenticated actor. Only that constructor is exempt; every other rule stays.
    files: [
      'apps/api/src/modules/identity/application/access/session-authenticator.ts',
      `${FIXTURES}/src/modules/identity/application/access/session-authenticator.ts`,
    ],
    rules: {
      'no-restricted-syntax': [
        'error',
        ...domainApplicationSyntax(contextsAreMintedByPlatformExcept(['authenticatedActor'])),
      ],
      '@typescript-eslint/no-restricted-imports': contextImportsOfTheAuthenticator,
    },
  },
  {
    // The shared kernel is framework-free and used by both api and web (ADR-0008), spec
    // files included.
    files: [
      `packages/shared-kernel/src/**/*.${TS}`,
      `${FIXTURES}/packages/shared-kernel/src/**/*.${TS}`,
    ],
    rules: { 'no-restricted-imports': kernelImports('^(?!\\./)|\\.\\.') },
  },
  {
    files: ['packages/shared-kernel/src/time.ts', `${FIXTURES}/packages/shared-kernel/src/time.ts`],
    rules: { 'no-restricted-imports': kernelImports('^(?!\\./|temporal-polyfill$)|\\.\\.') },
  },
  {
    files: [...SPEC_FILES, `**/test/**/*.${TS}`],
    languageOptions: { globals: { ...globals.jest } },
  },
  {
    // The operations panel (marketplace ADR-0033, ADR-0034): browser code. No raw colours (every
    // colour is a token), no physical left/right utilities (logical ones keep a right-to-left
    // Market working), no raw HTML injection. The panel config files run in Node.
    files: ['apps/panel/**/*.{ts,tsx}', 'packages/ui/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
    rules: {
      'no-restricted-syntax': ['error', ...panelSyntaxRules],
    },
  },
  {
    // The courier app: the wall-clock and Market-literal rules hold there too. Its Clock lives
    // in src/platform/clock/ (the block for that directory above), and Market values come from
    // the API.
    files: [`apps/courier/src/**/*.${TS}`, ...COURIER_TSX],
    ignores: ['apps/courier/src/platform/clock/**', 'apps/courier/test/**'],
    rules: {
      'no-restricted-syntax': ['error', ...noMarketOrVerticalLiterals, ...noWallClock],
    },
  },
  {
    files: ['apps/courier/test/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.jest } },
  },
  {
    files: ['**/*.mjs', '**/*.cjs', '**/*.js'],
    languageOptions: { globals: { ...globals.node } },
  },
  prettier,
);
