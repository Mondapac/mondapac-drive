// Architecture boundaries of the modular monolith, enforced in CI (ADR-0008 decision 6,
// ADR-0004 decision 3). Paths are relative to apps/api; the shared kernel, reached through
// the `paths` of tsconfig.json, appears as `../../packages/shared-kernel/...`. Every rule has
// a deliberate violation in test/boundary-fixtures/, asserted by test/boundaries.spec.ts.
// The rule numbers in comments are those of platform-foundations design 8.2.

// The one file that builds authenticated actors (identity design 4 rule 1; slice 2).
const AUTHENTICATOR_FILE = 'src/modules/identity/application/access/session-authenticator\\.ts';

// Modules that `identity` may import, through their index.ts only. Empty by decision
// (ADR-0018 decision 4, ADR-0020 A9): `legal` joins only by a named decision at its gate.
const IDENTITY_MAY_IMPORT = [];

// The seller-access contract of identity (sellerAccessOf, listRegisteredSellers): the one file
// besides index.ts that another module may import, and only `sellers` does (ADR-0022 decision 6,
// Ali's condition at sellers G2). It is not exported by identity's index.ts.
const SELLER_ACCESS_CONTRACT_FILE =
  '^src/modules/identity/contracts/seller-access\\.contract\\.ts$';

// The approved-seller-zones contract of sellers (ApprovedSellerZonesReader, APPROVED_SELLER_ZONES):
// the second file besides index.ts that another module may import, and only certification's
// application layer does (sellers design 7.1a; Hassan L4). It is not exported by sellers' index.ts.
const APPROVED_SELLER_ZONES_CONTRACT_FILE =
  '^src/modules/sellers/contracts/approved-seller-zones\\.contract\\.ts$';

// The file of `@NoMarketContext()` and the only files that may import it (design 8.2 rule 6,
// CTO decision of slice 0 item 3): the guard reads the exemption, the health controller uses
// it. Both files export only their own names (asserted in boundaries.spec.ts).
// inventory's ordering port: importable by ordering only (rule inventory-ordering-port-is-for-ordering).
const INVENTORY_ORDERING_PORT_FILE = '^src/modules/inventory/contracts/ordering-port\\.ts$';

const MARKET_EXEMPTION_FILE = '^src/platform/market-context/no-market-context\\.decorator\\.ts$';
const MARKET_EXEMPTION_IMPORTERS = [
  '^src/platform/market-context/market-context\\.guard\\.ts$',
  '^src/platform/health/health\\.controller\\.ts$',
];

// The one model entry point of platform/ai (ADR-0019 R2, R7): the gateway and the provider behind
// it. Besides platform/ai itself, only the files on this checked-in allow-list import them; the
// port's types (model-provider.ts) carry no call and may be imported by an AI module's ports.
const MODEL_ENTRY_ALLOW_LIST = [
  '^src/platform/ai/',
  '^src/app\\.module\\.ts$',
  '^src/modules/assistant/infrastructure/gateway-assistant-runtime\\.ts$',
  '^src/modules/assistant/infrastructure/assistant-providers\\.ts$',
];

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      // Rule 1.
      name: 'platform-does-not-import-modules',
      comment:
        'platform/ is below the modules: it may not import any module, not even through its ' +
        "index.ts (ADR-0018 decision 4). Modules implement platform's ports instead.",
      severity: 'error',
      from: { path: '^src/platform/' },
      to: { path: '^src/modules/' },
    },
    {
      // Rule 2.
      name: 'identity-imports-no-module',
      comment:
        'identity imports no other module, not even through its index.ts (identity brief R7, ' +
        'ADR-0018 decision 4, ADR-0020 A9). The allow-list IDENTITY_MAY_IMPORT is empty.',
      severity: 'error',
      from: { path: '^src/modules/identity/' },
      to: {
        path: '^src/modules/',
        pathNot: [
          '^src/modules/identity/',
          ...IDENTITY_MAY_IMPORT.map((module) => `^src/modules/${module}/index\\.ts$`),
        ],
      },
    },
    {
      // Catalog design 15.1 slice P1 (ADR-0024 decision 5): "sellable now" is composed by cart
      // and ordering, never by catalog.
      name: 'catalog-imports-neither-pricing-nor-inventory',
      comment:
        'catalog imports neither pricing nor inventory, not even through their index.ts ' +
        '(ADR-0024 decision 5, catalog design 9.1): no price, stock or "sellable now" in any ' +
        'catalog answer. Those modules consume catalog events and its facade instead.',
      severity: 'error',
      from: { path: '^src/modules/catalog/' },
      to: { path: '^src/modules/(pricing|inventory)/' },
    },
    {
      // Rule 3.
      name: 'temporal-only-through-kernel',
      comment:
        'Temporal comes from @mondapac-drive/shared-kernel only (ADR-0015 decision 4, ADR-0020 ' +
        'decision 7). The pattern matches the bare specifier, because pnpm does not resolve ' +
        'the polyfill from apps/api, and also a resolved path, should hoisting ever change.',
      severity: 'error',
      from: { path: '^src/' },
      to: { path: '(^|/node_modules/)(temporal-polyfill|@js-temporal/polyfill)(/|$)' },
    },
    {
      // Rule 6.
      name: 'market-exemption-is-platform-only',
      comment:
        'Only the market guard and the health controller may import @NoMarketContext() (ADR-0015 ' +
        'decision 3: only health and docs are exempt). An allow-list of importers, so that a ' +
        're-export cannot carry the exemption elsewhere.',
      severity: 'error',
      from: { pathNot: MARKET_EXEMPTION_IMPORTERS },
      to: { path: MARKET_EXEMPTION_FILE },
    },
    {
      // Not in 8.2: the security review of slice 0 item 4 (M2). The factory is global, so the
      // import rules alone did not stop a module from reaching it through MarketContextModule,
      // a barrel or Nest's metadata, or from copying the health controller's exemption.
      name: 'market-context-only-through-the-decorator',
      comment:
        'A module takes its Market from @Market() and imports nothing else from ' +
        'platform/market-context/ or platform/health/: no factory, module, guard, tenant, ' +
        'exemption or health controller.',
      severity: 'error',
      from: { path: '^src/modules/' },
      to: {
        path: '^src/platform/(market-context|health)/',
        pathNot: '^src/platform/market-context/market\\.decorator\\.ts$',
      },
    },
    {
      // W3 of platform-foundations 8.2 (identity slice 1d).
      name: 'market-context-is-attached-by-the-guard',
      comment:
        'The request-to-Market map is imported only by MarketContextGuard, which attaches a ' +
        "request's Market, and by the @Market() decorator file, which reads it.",
      severity: 'error',
      from: {
        pathNot: [
          '^src/platform/market-context/market-context\\.guard\\.ts$',
          '^src/platform/market-context/market\\.decorator\\.ts$',
        ],
      },
      to: { path: '^src/platform/market-context/attached-market-context\\.ts$' },
    },
    {
      // Platform-foundations 5.2 rule 4 (identity slice 1d), the same shape as W3.
      name: 'request-actor-is-attached-by-the-actor-guard',
      comment:
        "The request-to-actor map is imported only by ActorGuard, which attaches a request's " +
        'actor, and by the @Call() decorator file, which builds the CallContext from it.',
      severity: 'error',
      from: {
        pathNot: [
          '^src/platform/call-context/actor\\.guard\\.ts$',
          '^src/platform/call-context/call-context\\.decorator\\.ts$',
        ],
      },
      to: { path: '^src/platform/call-context/request-actor\\.ts$' },
    },
    {
      // Rule 8.
      name: 'kernel-testing-only-in-tests',
      comment:
        'The fakes of @mondapac-drive/shared-kernel/testing are never bound in a running process: ' +
        'src/ (spec files are excluded) and the kernel itself may not import them. The subpath ' +
        "resolves through tsconfig.json's paths to the kernel's src/testing.ts; dist/ and the " +
        'bare specifier are matched as well.',
      severity: 'error',
      from: { path: ['^src/', 'packages/shared-kernel/src/'] },
      to: {
        path: [
          'packages/shared-kernel/src/testing\\.ts$',
          'packages/shared-kernel/dist/testing\\.(js|d\\.ts)$',
          '^@mondapac-drive/shared-kernel/testing$',
        ],
      },
    },
    {
      // Not in 8.2: Bagher's (qc-release-manager) condition (a) for slice 0 item 4.
      name: 'kernel-only-through-package-entries',
      comment:
        'Outside the kernel, code reaches it only by its package names (@mondapac-drive/shared-kernel ' +
        'and its /testing, /contexts and /authenticated-actor entries), never by a path into ' +
        'its src/ or dist/ and never by a deeper subpath: minting must stay inside the kernel, ' +
        'in one copy per process.',
      severity: 'error',
      from: { pathNot: 'packages/shared-kernel/' },
      to: {
        path: [
          'packages/shared-kernel/(src|dist)/',
          '^@mondapac-drive/shared-kernel/(?!(testing|contexts|authenticated-actor)$)',
        ],
        // The package names resolve through tsconfig.json's paths, which marks them aliased.
        dependencyTypesNot: ['aliased'],
      },
    },
    {
      // Rule 5 of 8.2 for the slice 1c constructors (identity slice 1c; foundations 3.7, 5.2).
      // ESLint's rule 5 matches names; this rule closes the entry itself, so no import form,
      // barrel or alias outside platform/ reaches the constructors.
      name: 'contexts-are-built-by-platform',
      comment:
        'Only the platform entry adapters build actors and call contexts: nothing outside ' +
        'src/platform/ imports @mondapac-drive/shared-kernel/contexts. A module receives its ' +
        'CallContext from the adapter that called it; it never mints a system actor.',
      severity: 'error',
      from: { pathNot: ['^src/platform/', 'packages/shared-kernel/'] },
      to: {
        path: [
          'packages/shared-kernel/src/contexts\\.ts$',
          'packages/shared-kernel/dist/contexts\\.(js|d\\.ts)$',
          '^@mondapac-drive/shared-kernel/contexts$',
        ],
      },
    },
    {
      // Rule 5 of 8.2 for the authenticated actor (identity slice 2; identity design 4 rule 1,
      // foundations 3.7): "built only by identity's Authenticator (one file)".
      name: 'authenticated-actor-is-built-by-the-authenticator',
      comment:
        "Only identity's Authenticator, the one file that builds actors from a valid session, " +
        'imports @mondapac-drive/shared-kernel/authenticated-actor. No other module, no other file ' +
        'of identity and no platform code mints an authenticated actor.',
      severity: 'error',
      from: {
        pathNot: [`^${AUTHENTICATOR_FILE}$`, 'packages/shared-kernel/'],
      },
      to: {
        path: [
          'packages/shared-kernel/src/authenticated-actor\\.ts$',
          'packages/shared-kernel/dist/authenticated-actor\\.(js|d\\.ts)$',
          '^@mondapac-drive/shared-kernel/authenticated-actor$',
        ],
      },
    },
    {
      // Rule 9 of 8.2, first half (identity design 5.2; foundations 6.4 row 2).
      name: 'use-cases-are-the-only-way-in',
      comment:
        'An entry point of a module (presentation/, which holds controllers, jobs/ and ' +
        'subscribers/; contracts/; and every *.facade.ts implementation) imports from its ' +
        "module's application/ only use-cases/*.use-case.ts, so the UseCaseGate runs for " +
        "everything an entry point reaches. The module's index.ts is an entry point too " +
        '(security review of slice 1c, L2). Drive: delivery is exempt until identity brings ' +
        'the UseCaseGate and its use cases move to use-cases/ (work package 2); remove the ' +
        'pathNot below with that move.',
      severity: 'error',
      from: {
        path: '^src/modules/([^/]+)/(?:presentation/|contracts/|index\\.ts$|.+\\.facade\\.ts$)',
        pathNot: '^src/modules/delivery/',
      },
      to: {
        path: '^src/modules/$1/application/',
        pathNot: '^src/modules/$1/application/use-cases/[^/]+\\.use-case\\.ts$',
      },
    },
    {
      // Rule 9 of 8.2, second half (identity design 5.2).
      name: 'repositories-stay-behind-use-cases',
      comment:
        'A repository (a *.repository.ts file) is imported only by application/ and ' +
        "infrastructure/ of a module, and by the module's Nest module, which binds the " +
        'implementation to its port. Controllers, jobs, subscribers and facades go through a ' +
        'use case.',
      severity: 'error',
      from: {
        pathNot: [
          '^src/modules/[^/]+/(application|infrastructure)/',
          '^src/modules/[^/]+/[^/]+\\.module\\.ts$',
        ],
      },
      to: { path: '^src/modules/[^/]+/.+\\.repository\\.ts$' },
    },
    {
      // Security review of slice 1c, M1.
      name: 'use-case-gate-is-built-by-authz',
      comment:
        'Only platform/authz/ imports the gate file, which holds the factory that builds a ' +
        'UseCaseGate: a gate built elsewhere could bind a lenient registry or check. Modules ' +
        'inject USE_CASE_GATE from the platform/authz barrel.',
      severity: 'error',
      from: { pathNot: '^src/platform/authz/' },
      to: { path: '^src/platform/authz/use-case-gate\\.ts$' },
    },
    {
      // Security review of slice 1c, M1.
      name: 'modules-reach-authz-through-its-barrel',
      comment:
        'A module imports from platform/authz/ only its index.ts: the base class, the ' +
        "declaration types, the permission helpers, the answers and the gate's token and type.",
      severity: 'error',
      from: { path: '^src/(?:modules|verticals)/' },
      to: { path: '^src/platform/authz/', pathNot: '^src/platform/authz/index\\.ts$' },
    },
    {
      // Security review of slice 1c, L3.
      name: 'subject-keys-only-in-infrastructure',
      comment:
        'Encrypting or hashing a field is persistence work: in a module, only infrastructure/ ' +
        'uses the SubjectKeyService.',
      severity: 'error',
      from: {
        path: '^src/(?:modules|verticals)/',
        pathNot: '^src/modules/[^/]+/infrastructure/',
      },
      to: { path: '^src/platform/subject-keys/' },
    },
    {
      // Security review of slice 1c, L3.
      name: 'subject-keys-only-through-the-port',
      comment:
        'A module reaches subject keys through the port (subject-key-service.ts) and its labels ' +
        '(labels.ts) only: never the wrapper, the key store or the implementation.',
      severity: 'error',
      from: { path: '^src/(?:modules|verticals)/' },
      to: {
        path: '^src/platform/subject-keys/',
        pathNot: '^src/platform/subject-keys/(?:subject-key-service|labels)\\.ts$',
      },
    },
    {
      name: 'model-entry-only-from-the-allow-list',
      comment:
        'A model is called only through platform/ai (ADR-0019 R7), and only the files on ' +
        'MODEL_ENTRY_ALLOW_LIST import its entry point (R2): never a domain/ file, a decision ' +
        'use case or a module without an approved AI use.',
      severity: 'error',
      from: { pathNot: MODEL_ENTRY_ALLOW_LIST },
      to: {
        path: '^src/platform/ai/',
        pathNot: '^src/platform/ai/model-provider\\.ts$',
      },
    },
    {
      name: 'model-provider-sdks-only-in-platform-ai',
      comment: 'No provider SDK is imported outside platform/ai (ADR-0019 R7).',
      severity: 'error',
      from: { pathNot: '^src/platform/ai/' },
      to: { path: '(?:^|/)(?:@anthropic-ai|openai|@google/generative-ai|@aws-sdk/client-bedrock)' },
    },
    {
      name: 'module-public-api-only',
      comment: "A module may import another module only through that module's index.ts.",
      severity: 'error',
      from: { path: '^src/modules/([^/]+)/' },
      to: {
        path: '^src/modules/[^/]+/',
        pathNot: [
          '^src/modules/$1/',
          '^src/modules/[^/]+/index\\.ts$',
          SELLER_ACCESS_CONTRACT_FILE,
          APPROVED_SELLER_ZONES_CONTRACT_FILE,
          INVENTORY_ORDERING_PORT_FILE,
        ],
      },
    },
    {
      name: 'seller-access-contract-is-for-sellers',
      comment:
        "Only the sellers module imports identity's seller-access contract (sellerAccessOf, " +
        'listRegisteredSellers and notifyAccessReviewers): every other consumer of seller access would bypass the one ' +
        "may-sell contract that sellers owns (ADR-0022 decision 6). identity's index.ts does " +
        'not export the contract file.',
      severity: 'error',
      from: { pathNot: ['^src/modules/identity/', '^src/modules/sellers/'] },
      to: { path: SELLER_ACCESS_CONTRACT_FILE },
    },
    {
      name: 'inventory-ordering-port-is-for-ordering',
      comment:
        "inventory's ordering port (contracts/ordering-port.ts: reserve, releaseReservation, " +
        'releaseOwnReservation) is the only way to hold stock for a checkout, and only ordering ' +
        "calls it (inventory design 7.2). inventory's index.ts does not export it.",
      severity: 'error',
      from: { pathNot: ['^src/modules/inventory/', '^src/modules/ordering/'] },
      to: { path: '^src/modules/inventory/contracts/ordering-port\\.ts$' },
    },
    {
      name: 'approved-seller-zones-contract-is-for-certification',
      comment:
        "Only certification's application and infrastructure layers and its Nest module import " +
        "sellers' approved-seller-zones contract (APPROVED_SELLER_ZONES); certification reaches " +
        'it through a certification-owned port with an infrastructure adapter that imports the ' +
        'token. Its anonymous/system use-case pair answers every caller the same way and must ' +
        'stay out of every other path (sellers design 7.1a; Hassan L4). Decision basis: ADR-0033 ' +
        "(pending), restricted contract files, amends ADR-0008. sellers' index.ts does not " +
        'export the contract file.',
      severity: 'error',
      from: {
        pathNot: [
          '^src/modules/sellers/',
          '^src/modules/certification/(application|infrastructure)/',
          '^src/modules/certification/certification\\.module\\.ts$',
        ],
      },
      to: { path: APPROVED_SELLER_ZONES_CONTRACT_FILE },
    },
    {
      name: 'approved-seller-zones-use-cases-stay-in-sellers-reader',
      comment:
        'Inside sellers only the reader implementation and the Nest module import the ' +
        'approved-seller-zones use cases (the anonymous/system pair); a controller, job or ' +
        'subscriber of sellers must not reach them (Hassan L1). ADR-0033 (pending).',
      severity: 'error',
      from: {
        path: '^src/modules/sellers/',
        pathNot: [
          '^src/modules/sellers/presentation/approved-seller-zones\\.reader\\.ts$',
          '^src/modules/sellers/sellers\\.module\\.ts$',
          '^src/modules/sellers/application/use-cases/approved-seller-zones(-system)?\\.use-case\\.ts$',
          '\\.spec\\.ts$',
        ],
      },
      to: {
        path: '^src/modules/sellers/application/use-cases/approved-seller-zones(-system)?\\.use-case\\.ts$',
      },
    },
    {
      name: 'certification-surface-does-not-reach-reader-adapter',
      comment:
        "Certification's public surface (presentation, contracts and index.ts) must not import " +
        "its infrastructure, where the adapter of sellers' approved-seller-zones contract lives: " +
        'the token must not leak through a re-export or a controller. ADR-0033 (pending), ' +
        'restricted contract files, amends ADR-0008.',
      severity: 'error',
      from: {
        path: [
          '^src/modules/certification/(presentation|contracts)/',
          '^src/modules/certification/index\\.ts$',
        ],
      },
      to: { path: '^src/modules/certification/infrastructure/' },
    },
    {
      name: 'module-internals-are-private',
      comment: 'Code outside modules/ may import a module only through its index.ts.',
      severity: 'error',
      from: { pathNot: '^src/modules/' },
      to: { path: '^src/modules/[^/]+/', pathNot: '^src/modules/[^/]+/index\\.ts$' },
    },
    {
      name: 'domain-is-pure',
      comment:
        'domain/ holds pure business rules: it may import only its own domain/ and the ' +
        'shared kernel. No NestJS, no Prisma, no I/O, no other layer.',
      severity: 'error',
      from: { path: '^src/modules/([^/]+)/domain/' },
      // The kernel arrives through tsconfig.json's paths (positive fixture: domain/uses-kernel.ts).
      to: { pathNot: ['^src/modules/$1/domain/', 'packages/shared-kernel/'] },
    },
    {
      name: 'application-does-not-know-delivery',
      comment: 'application/ defines ports; it may not import infrastructure/ or presentation/.',
      severity: 'error',
      from: { path: '^src/modules/([^/]+)/application/' },
      to: { path: '^src/modules/[^/]+/(infrastructure|presentation)/' },
    },
    {
      name: 'core-does-not-import-verticals',
      comment: 'Core (modules/, platform/) must not depend on any vertical (ADR-0001).',
      severity: 'error',
      from: { path: '^src/(modules|platform)/' },
      to: { path: '^src/verticals/' },
    },
    {
      name: 'prisma-only-in-infrastructure',
      comment:
        'The Prisma client is imported only from modules/<m>/infrastructure/ and ' +
        'platform/persistence/ (ADR-0004 decision 3).',
      severity: 'error',
      from: {
        pathNot: [
          '^src/modules/[^/]+/infrastructure/',
          '^src/platform/persistence/',
          '^src/generated/',
        ],
      },
      to: { path: ['^src/generated/', 'node_modules/@prisma/'] },
    },
    {
      name: 'persistence-internals-are-private',
      comment:
        'PrismaService is the door to the database. Outside modules/<m>/infrastructure/ and ' +
        'platform/persistence/, code may import only PersistenceModule, DatabaseProbe and ' +
        'the error reducer of platform persistence design 12.3 (it imports no Prisma) from ' +
        'platform/persistence/, so a re-export cannot leak the client.',
      severity: 'error',
      from: {
        pathNot: ['^src/modules/[^/]+/infrastructure/', '^src/platform/persistence/'],
      },
      to: {
        path: '^src/platform/persistence/',
        pathNot:
          '^src/platform/persistence/(persistence\\.module|database-probe|database-error)\\.ts$',
      },
    },
    {
      // Platform persistence design 12.2, rule 2.
      name: 'persistence-root-is-private',
      comment:
        "A module's infrastructure/ imports nothing of platform/persistence/ but " +
        'prisma.service.ts and raw-reads/raw-read-port.ts (ADR-0030: the read-only port): never the base client (PrismaRoot), the guarded client, the ' +
        'unit store or the guard, so its only door to the database is tx(market).',
      severity: 'error',
      from: { path: '^src/modules/[^/]+/infrastructure/' },
      to: {
        path: '^src/platform/persistence/',
        pathNot: '^src/platform/persistence/(prisma\\.service|raw-reads/raw-read-port)\\.ts$',
      },
    },
    {
      name: 'database-driver-only-in-infrastructure',
      comment: 'The PostgreSQL driver is used only by infrastructure/ and platform/persistence/.',
      severity: 'error',
      from: {
        pathNot: [
          '^src/modules/[^/]+/infrastructure/',
          '^src/platform/persistence/',
          '^src/generated/',
        ],
      },
      to: { path: 'node_modules/(pg|pg-[^/]+|@types/pg)/' },
    },
    {
      // ADR-0030, Ali's ruling C-e. The boundary script reaches the parser through
      // createRequire from apps/api, so the cruiser does not see that second importer.
      name: 'sql-parser-only-in-pg-parser',
      comment:
        'libpg-query is imported only by platform/persistence/raw-reads/pg-parser.ts (and, ' +
        'outside src, by scripts/check-prisma-boundaries.mjs through createRequire from apps/api).',
      severity: 'error',
      from: { pathNot: '^src/platform/persistence/raw-reads/pg-parser\\.ts$' },
      to: { path: '(^|/node_modules/)libpg-query(/|$)' },
    },
    {
      name: 'no-circular',
      comment: 'Circular dependencies hide coupling between files and modules.',
      severity: 'error',
      from: { pathNot: '^src/generated/' },
      to: { circular: true },
    },
  ],
  options: {
    tsConfig: { fileName: 'tsconfig.json' },
    tsPreCompilationDeps: true,
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '\\.spec\\.ts$' },
  },
};
