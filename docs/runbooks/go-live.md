# Go-live checklist (Brisbane pilot)

Everything a deployed Drive stack needs that the repository cannot hold: secrets, provider
accounts and hosts. **Owner** means the project owner signs up for the account and hands over the
key. **Kazem** (devops) puts every value into the stack's secret store and environment.
Nothing here may be committed. `.env.example` lists the local stand-ins.

A stack refuses to start in `NODE_ENV=production` while a stand-in it depends on is still in
place. Those are marked **blocks start**.

## API (`apps/api`, roles `api` and `worker`)

| Variable | What it is for | Who | Notes |
| --- | --- | --- | --- |
| `NODE_ENV=production` | Turns off every local stand-in, and the mail catcher | Kazem | Must be set explicitly; unset fails closed |
| `APP_ROLE` | `api` (HTTP) or `worker` (relay, dispatcher, scheduler) | Kazem | One deployment per role |
| `HOSTED_MARKETS=AU` | Markets this Region Stack serves | Kazem | |
| `DATABASE_URL` | The application login (`drive_api`, member of `drive_app`) | Kazem | Never the migrator; the app refuses `MIGRATION_DATABASE_URL` in its env |
| `MIGRATION_DATABASE_URL` | The migration role, for `pnpm db:migrate` in the release job only | Kazem | Not in the api or worker env |
| `DATABASE_POOL_MAX` | Pool size per process (default 10) | Kazem | |
| `REDIS_URL` | Live courier positions, route cache | Kazem | **Must be `rediss://`** (TLS) in production |
| `GOOGLE_MAPS_API_KEY` | Road routing, ETAs and geocoding for AU (`routing.google.apiKeyEnv`) | Owner (Google Cloud account) → Kazem | Restrict the key to the Routes and Geocoding APIs and the stack's egress IPs; set a daily quota. Unset: straight-line estimates |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` | Recipient SMS (tracking link, delivery PIN) | Owner (Twilio account, AU sender) → Kazem | Both or neither. Unset: SMS are retried, then dead-lettered |
| `NOTIFICATIONS_WEBHOOK_KEY` | Root key for every merchant webhook signing secret (base64, 32+ random bytes) | Kazem generates | **Blocks start.** Rotating it changes every merchant's secret |
| `DELIVERY_PIN_KEY` | HMAC key for recipient proof-of-delivery PINs | Kazem generates | **Blocks start.** Rotating it invalidates the PINs of open deliveries |
| `STRIPE_SECRET_KEY` | Stripe Connect: courier onboarding links and payouts | Owner (Stripe Connect platform account) → Kazem | Test-mode key for the pilot until the owner says live. Both this and `STRIPE_WEBHOOK_SECRETS`, or neither |
| `STRIPE_WEBHOOK_SECRETS` | Signing secrets of Stripe's webhook to `payouts/AU/provider-webhook` (comma-separated, for rotation) | Kazem, from the Stripe dashboard | Both or neither, with `STRIPE_SECRET_KEY` |
| `EXPO_ACCESS_TOKEN` | Push notifications for courier offers (package 33) | Owner (Expo account) → Kazem | Only after package 33 merges |
| `TRUSTED_BFF_CIDRS`, `CLIENT_ADDRESS_KEYS` | Let the panel's BFF pass the real client address (rate limits, sign-in throttles) | Kazem | Both or neither |
| `MAIL_CATCHER_URL` | Local Mailpit only | — | **Must be unset**; refused in production |
| `OBJECT_STORE_DIR` | Local disk store for documents and proof photos | — | The deployed object store adapter is still to come: **blocks go-live** for courier documents and photos (Kazem + Hossein) |
| `LOG_LEVEL` | `info` (the worker requires info, debug or trace) | Kazem | |
| `API_DOCS_ENABLED` | Swagger UI | Kazem | `false` in production |
| `PORT` | HTTP port of the api role | Kazem | |

Local stand-ins that have no deployed adapter yet, and **block start** in production until one
lands (Hossein builds the adapter, Kazem wires the key-management service):

- subject key wrapping (`platform/subject-keys`, personal-data encryption keys);
- the identity throttle secret and second-factor secrets (`identity` sessions and TOTP);
- the rate-limit origin secret (`platform/rate-limit`).

## Market configuration (`config/markets/AU.json`)

Not secrets, but they must hold the real values before go-live (a code change, reviewed):

- `allowedOrigins.admin`: the dispatch panel's host. `courier` and `merchant` stay as decided.
  It is empty today, so every unsafe admin request is refused.
- `identity.links.targets`: the real panel and courier-app link pages
  (`*.drive.mondapac.test` today).
- `fleet.courierApp.supportPhone`: the real AU support line (placeholder `+61700000000`;
  **owner**).
- `events.inboxRetentionDays` (30): handled inbox rows are purged after this many days
  (`platform.inbox-retention`).

## Operations panel (`apps/panel`)

| Variable | What it is for | Who |
| --- | --- | --- |
| `API_BASE_URL` | The API the BFF calls | Kazem |
| `PANEL_HOSTS` | `origin=MARKET` pairs the panel serves (for example `https://dispatch.au.drive.mondapac.com=AU`) | Kazem |
| `PANEL_LOCALE`, `PANEL_MARKET_NAME`, `PANEL_SUPPORT_EMAIL`, `PANEL_PASSWORD_LENGTH` | What the panel shows per Market | Kazem, from the owner |
| `PANEL_MAP_STYLE_URL`, `PANEL_MAP_ORIGINS` | The live map's tile style and the hosts its tiles load from (CSP) | Owner (map provider account) → Kazem |
| `PANEL_MAP_CENTERS`, `PANEL_MAP_ZOOM` | The map's starting view per Market | Kazem |

## Courier app (`apps/courier`, EAS builds)

| Variable | What it is for | Who |
| --- | --- | --- |
| `EXPO_PUBLIC_API_URL` | The API the release build calls (a release build refuses the mock) | Kazem |
| `EXPO_PUBLIC_MARKET_ID=AU` | The Market the build signs in to | Kazem |
| Apple Developer and Google Play accounts, EAS credentials | Store builds (package 40) | **Owner** |

## Before the first courier signs in

1. Run migrations with the migration role (`pnpm db:migrate`); start one worker, so the roles
   get seeded at start (`identity.seed-roles`).
2. Create the first admin with the operator routine `first-admin --market AU --email <owner's
   address>`. Never use `pnpm dev:seed`: it refuses production and non-local databases, and it is
   not part of any image.
3. Configure alerts (next section), then check `GET /health/ready` on every api instance.

## Alerts

| Alert | Source | Action |
| --- | --- | --- |
| A dead-lettered event (`msg: event-delivery.dead`, `alert: true`) | worker log | [stuck-courier.md](stuck-courier.md) when the subscriber is `fleet.*`; otherwise the owning module's runbook |
| A courier job open for more than 12 hours | the monitoring query in [stuck-courier.md](stuck-courier.md), every 15 min | [stuck-courier.md](stuck-courier.md) |
| Any other error line with `alert: true` (audit chain findings, `platform/audit/audit-alerts.ts`) | api and worker logs | Escalate to Hassan |
| A payout line `unresolved` or `held` | the panel's payouts screen | [payouts-unresolved-line.md](payouts-unresolved-line.md) |
| `worker.heartbeat` missing for 3 minutes | worker log | Restart the worker; check the database |
