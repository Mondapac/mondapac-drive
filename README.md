# Mondapac Drive

Fleet management and last-mile delivery for the Mondapac marketplace, in the spirit of Uber
Direct, DoorDash Drive and Zoom2u. First Market: Australia, starting in Greater Brisbane.
Plan: `docs/plan.md`. Decisions: `docs/adr/`.

## What works today

Every route is scoped to a Market by the `x-market-id` header (the marketplace's convention).

Three populations sign in, each with its own credential (identity, copied from the marketplace):

- **Admins** (operations staff) use the panel: password plus second factor, a `__Host-` session
  cookie, CSRF token and panel origin on every unsafe request. Platform roles: Platform
  Administrator, Operator (merchants, couriers and deliveries read, cancel) and Dispatcher
  (onboards couriers, dispatches); custom roles are edited in the panel.
- **Merchants** (the marketplace and other shops) call the API with an API key
  (`Authorization: Bearer ms1_...`). Keys are stored hashed, scoped to one Market and one merchant,
  expire per Market (`identity.apiKeys`) and are issued, listed and revoked by an admin.
- **Couriers** are invited by a dispatcher, accept with a name and password, and sign in from the
  app with a bearer session.

Delivery routes, by population:

- Merchant: `POST /delivery/quotes` prices a delivery (cheapest vehicle that fits weight, volume,
  distance and temperature; cold-chain surcharge; scheduled discount; tax inside the price;
  amounts as decimal text in minor units). `POST /delivery/deliveries` books it, idempotent on
  (merchant, external reference); `expectedTotal` refuses a changed price. `GET` and
  `POST .../:id/cancel` see only the merchant's own deliveries.
- Admin: `GET /delivery/admin/deliveries` lists the Market's deliveries newest first (filters
  `status`, `merchantId`, `courierId`; paged with `before`; no stop addresses or contacts),
  `GET .../:id` reads one, `POST .../:id/dispatch` opens dispatch and assigns or unassigns a
  courier (`courierId` is the courier's identity account id), `POST .../:id/cancel` cancels.
  `GET /identity/admin/couriers` lists courier accounts and pending invitations.
- Courier: `GET /delivery/courier/deliveries/:id` and `POST .../:id/events` for the assigned
  courier only. The lifecycle is enforced; chilled and frozen parcels need temperature readings at
  pickup and drop-off; a delivery needs a PIN or a photo as proof.
- `GET /health` and `GET /health/ready` are public.

Deliveries are stored in PostgreSQL (PostGIS points) through the platform runtime copied from the
marketplace: unit of work and market guard, outbox, relay and event delivery, audit log (hash
chained), rate limits, scheduler and worker role (`APP_ROLE=worker`).

The operations panel (`apps/panel`, Next.js, copied from the marketplace admin panel) is where
operators and dispatchers sign in, run the team and roles, add merchants and issue their API keys
(shown once), invite and disable couriers, follow deliveries and dispatch or cancel them. Its
server relays an allowlist of admin routes to the API with the session cookie and CSRF token.
Run it with `cp apps/panel/.env.example apps/panel/.env.local` and `pnpm --filter
@mondapac-drive/panel dev` (http://admin.localhost:3002); the Market's `allowedOrigins.admin`
must list the panel's origin.

Not yet: real road distances (a straight-line estimate x 1.3 for now). Rate cards in
`config/markets/` are placeholders.

## Getting started

Node.js 24.20 or later, pnpm 10, Docker.

```bash
cp .env.example .env
docker compose up -d     # PostgreSQL + PostGIS on 5433 (roles from scripts/db/), Redis on 6380
pnpm install
pnpm db:migrate          # as drive_migrator
pnpm verify              # typecheck, lint, boundaries, tests, database tests, migration check
pnpm dev                 # API on http://localhost:3100 (API docs at /docs with API_DOCS_ENABLED)
```

On a volume created before the role model, recreate it: `docker compose down -v`.

## Layout

```
apps/api/                NestJS modular monolith: src/modules (bounded contexts), src/platform
apps/courier/            Courier app (React Native, Expo) - Phase 1 slice 6
apps/panel/              Operations panel for operators and dispatchers (Next.js)
packages/ui/             Panel components and design tokens (from the marketplace)
packages/panel-server/   Server-only panel helpers: signed client address, request wrapper
packages/shared-kernel/  Framework-free kernel copied from the marketplace (Money, ids, Temporal,
                         contexts, events, audit fields) plus GeoPoint
config/markets/          Market configuration as code, validated at start-up
config/service-areas/    Where each Market delivers, by postcode
test/fixtures/           Synthetic second market (ZZ) used by tests
prisma/                  One schema file per module, migrations with down.sql
scripts/                 Boundary, migration and build checks; db/ holds the cluster bootstrap
docs/                    Plan, ADRs and the design tokens the panel imports
```
