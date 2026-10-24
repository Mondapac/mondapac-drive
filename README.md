# Mondapac Drive

Fleet management and last-mile delivery for the Mondapac marketplace, in the spirit of Uber
Direct, DoorDash Drive and Zoom2u. First Market: Australia, starting in Greater Brisbane.
Plan: `docs/plan.md`. Decisions: `docs/adr/`.

## What works today

- `POST /v1/markets/:market/quotes`: price a delivery. Picks the cheapest vehicle that can carry
  the parcel (weight, volume, distance, temperature), adds a cold-chain surcharge, discounts
  scheduled deliveries and states the tax inside the price.
- `POST /v1/markets/:market/deliveries`: book it. Idempotent on (merchant, external reference);
  `expectedTotal` refuses a booking whose price has changed since the quote.
- `POST /v1/markets/:market/deliveries/:id/events`: courier and dispatcher events. The lifecycle
  is enforced; chilled and frozen parcels need temperature readings at pickup and drop-off; a
  delivery needs a PIN or a photo as proof.
- `GET /v1/markets/:market/deliveries/:id` and `GET /health`.

Not yet: authentication (do not expose the API), a database-backed store (the in-memory one
loses everything on restart), real road distances (a straight-line estimate × 1.3 for now).
Rate cards in `config/markets/` are placeholders.

## Getting started

Node.js 24.20 or later, pnpm 10, Docker.

```bash
cp .env.example .env
docker compose up -d     # PostgreSQL + PostGIS on 5433, Redis on 6380
pnpm install
pnpm verify              # Prisma validate, typecheck, lint, tests
pnpm dev                 # API on http://localhost:3100
```

## Layout

```
apps/api/                NestJS modular monolith: src/modules (bounded contexts), src/platform
apps/courier/            Courier app (React Native, Expo) - Phase 1 slice 6
packages/shared-kernel/  Framework-free types (Money, MarketId, GeoPoint)
config/markets/          Market configuration as code, validated at start-up
test/fixtures/markets/   Synthetic second market (ZZ) used by tests
prisma/                  One schema file per module, migrations with down.sql
docs/                    Plan and ADRs
```
