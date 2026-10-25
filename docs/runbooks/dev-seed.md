# Dev seed and the courier smoke run

`pnpm dev:seed` fills an empty local database with one Market's working set, so the panel, the
courier app and the smoke run have someone to sign in as. CI runs the same commands (job
"Courier smoke run") for AU and ZZ on every pull request.

## What it makes

Everything goes through the real HTTP routes and use cases of the API, never SQL:

| What | How |
| --- | --- |
| First admin (Platform Administrator) | identity's `first-admin` operator routine, the mailed invitation, an authenticator secret and code, sign-in |
| Merchant with an API key | the admin's merchant routes |
| Courier account | the admin's courier invitation, accepted from the mailed link, signed in as the app does |
| Fleet profile, van, documents | the courier's fleet routes; the admin verifies every document, approves, sets tax registration; the courier goes online once and back offline |
| One delivery assigned to the courier | booked with the merchant's key, assigned on dispatch's admin route; its recipient PIN is read with the seed-only `delivery-pin` operator command |
| Sample deliveries (`--samples`, default 2, every other one chilled) | booked with the merchant's key and left to dispatch |

The seed process boots the API with the worker loops in one process, on a loopback port, and
catches its mails in memory (a stand-in for Mailpit's send interface), so nothing leaves the
machine. Market values (stops, service area, vehicle) come from
`scripts/dev-seed/markets/<MARKET>.json`; the document list comes from the Market config.

## Guard (security path)

The seed refuses to run unless **all** hold:

- `NODE_ENV` is set explicitly to `development` or `test`;
- the database name in `DATABASE_URL` ends in `_dev` or `_test`;
- the database host (and Redis, when set) is local, or listed in `DEV_SEED_ALLOWED_HOSTS`.

The seed also removes the outbound provider keys (Twilio, Stripe, Expo push, the routing keys)
from its own environment before it boots, so seed data never sends a real SMS, push or payout;
the AU sample phones are in ACMA's fictional range (`+61 491 570 xxx`).

A second run on the same database refuses (`already has its first admin`, exit 2). No image
starts the seed: it is a separate entry (`dist/dev-seed.js`) called only by `scripts/dev-seed.mjs`.

## Run it locally

```sh
# A fresh database with the suffix, bootstrapped and migrated.
psql -U postgres -c 'CREATE DATABASE drive_dev TEMPLATE template1'
psql -U postgres -d drive_dev -f scripts/db/bootstrap-dev.sql
MIGRATION_DATABASE_URL=postgresql://drive_migrator:drive_migrator@localhost:5433/drive_dev pnpm db:migrate

export NODE_ENV=development HOSTED_MARKETS=AU,ZZ
export DATABASE_URL=postgresql://drive_api:drive_api@localhost:5433/drive_dev
pnpm dev:seed --market AU            # --samples <n>, --out <file>
```

The credentials land in `.dev/seed/AU.json` (git-ignored, mode 600): the admin's email,
password, TOTP secret (add it to an authenticator app, or compute codes from it) and recovery
codes; the merchant's id and API key; the courier's email and password; the assigned delivery's
id and PIN; the sample delivery ids.

Start the API with the same local Market configuration, so it hosts ZZ and accepts the panel's
origin (AU's checked-in `allowedOrigins` stay empty until the real hosts are known):

```sh
export $(node scripts/dev-config.mjs)   # MARKET_CONFIG_DIR, SERVICE_AREA_CONFIG_DIR, LOCALE_CONFIG_DIR, OBJECT_STORE_DIR
APP_ROLE=api PORT=3100 node apps/api/dist/main
```

`DEV_ADMIN_ORIGINS=http://localhost:3001` (comma-separated) adds a local panel's origin to every
admin list. On Windows PowerShell, set the variables with `$env:NAME = "value"`; the scripts are
plain Node.

## Smoke run

```sh
pnpm smoke:courier --market AU          # --api <url>, default http://localhost:3100
```

It signs in as the seeded courier, goes online, pings, walks the assigned delivery to delivered
with its PIN, reads earnings, goes offline and signs out. It uses the delivery up: seed a fresh
database to run it again. Run it with `--samples 0` seeds, otherwise dispatch may offer a sample
delivery first and the smoke takes that offer instead.

## Notes

- Anonymous identity routes are limited per client address across all Markets of a stack
  (ZZ: 10 a minute). The seed waits out a 429; run ZZ's smoke before seeding AU in the same
  minute, as CI does.
- The smoke config (`apps/courier/jest.smoke.config.js`) runs in plain Node: the jest-expo preset
  replaces `fetch` with Expo's native one, which has no native module under Node.
