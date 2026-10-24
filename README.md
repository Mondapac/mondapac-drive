# Mondapac Drive

Fleet management and last-mile delivery for the Mondapac marketplace, in the spirit of Uber
Direct, DoorDash Drive and Zoom2u. First Market: Australia, starting in Greater Brisbane.
Plan: `docs/plan.md`. Decisions: `docs/adr/`.

## What works today

Every route is scoped to a Market by the `x-market-id` header (the marketplace's convention).

- `POST /delivery/quotes`: price a delivery. Picks the cheapest vehicle that can carry the
  parcel (weight, volume, distance, temperature), adds a cold-chain surcharge, discounts
  scheduled deliveries and states the tax inside the price. Amounts are decimal text in minor
  units.
- `POST /delivery/deliveries`: book it. Idempotent on (merchant, external reference);
  `expectedTotal` refuses a booking whose price has changed since the quote.
- `POST /delivery/deliveries/:id/events`: courier and dispatcher events. The lifecycle is
  enforced; chilled and frozen parcels need temperature readings at pickup and drop-off; a
  delivery needs a PIN or a photo as proof.
- `GET /delivery/deliveries/:id`, `GET /health` and `GET /health/ready`.

Deliveries are stored in PostgreSQL (PostGIS points) through the platform runtime copied from the
marketplace: unit of work and market guard, outbox, relay and event delivery, audit log, rate
limits, scheduler and worker role (`APP_ROLE=worker`).

Not yet: authentication (do not expose the API; it arrives with identity), real road distances
(a straight-line estimate x 1.3 for now). Rate cards in `config/markets/` are placeholders.

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
packages/shared-kernel/  Framework-free kernel copied from the marketplace (Money, ids, Temporal,
                         contexts, events, audit fields) plus GeoPoint
config/markets/          Market configuration as code, validated at start-up
config/service-areas/    Where each Market delivers, by postcode
test/fixtures/           Synthetic second market (ZZ) used by tests
prisma/                  One schema file per module, migrations with down.sql
scripts/                 Boundary, migration and build checks; db/ holds the cluster bootstrap
docs/                    Plan and ADRs
```
