# Courier app

React Native app for Mondapac Drive couriers: Expo SDK 58 (managed workflow), TypeScript strict,
expo-router, TanStack Query and Zod. Phase 1 slice 6 (`docs/plan.md`, handoff 08).

## Run it

```sh
pnpm install
pnpm --filter courier start:mock          # Expo Go / simulator, on the in-app mock backend
EXPO_PUBLIC_API_URL=https://… EXPO_PUBLIC_MARKET_ID=<code> pnpm --filter courier start   # real API
```

Without `EXPO_PUBLIC_API_URL` the app always uses the mock (`src/api/mock`). The mock accepts any
email and password (except `wrong-password`), offers the two fixture jobs in turn and takes the
delivery PIN `1234`. With a real API, `EXPO_PUBLIC_MARKET_ID` names the Market the build serves:
sign-in is scoped to it (`x-market-id`) and the session carries it afterwards.
A release build refuses to start on the mock or without an https `EXPO_PUBLIC_API_URL`; plain
http to localhost and LAN addresses works in development builds only.

Web (`expo start --web`) is a screen preview only: no background location, and the session is
kept in memory (`*.web.ts` files).

## Checks

`pnpm --filter courier typecheck` and `pnpm --filter courier test` (Jest, jest-expo and React
Native Testing Library). Both run in `pnpm verify` and CI through `pnpm -r`, and the root
`pnpm lint` lints the app. Rule tests run on AU and the synthetic ZZ Market, built from
`config/markets/AU.json` and `test/fixtures/markets/ZZ.json`.

### Smoke run against a real API

`pnpm --filter courier smoke` takes one courier through a day on a running API with the HTTP
adapter: sign-in, Market settings, online, a ping, the current offer (or `SMOKE_DELIVERY_ID`),
the lifecycle to delivered with the customer's PIN, earnings, offline, sign-out, and the old
token refused. It is not part of `pnpm verify`. It needs a seeded test courier and a delivery
the courier can take:

```sh
SMOKE_API_URL=http://localhost:3000 SMOKE_MARKET_ID=AU \
SMOKE_COURIER_EMAIL=… SMOKE_COURIER_PASSWORD=… SMOKE_DELIVERY_PIN=… \
pnpm --filter courier smoke
```

It records a real delivery, so it refuses a non-local `SMOKE_API_URL` unless
`SMOKE_ALLOW_REMOTE=1`; a failed run still sets the courier offline and signs out.

## Layout

- `src/app/`: routes (expo-router). Thin: each wires a screen to the router.
- `src/screens/`, `src/components/`, `src/ui/`: screens, their parts and the base widgets.
- `src/api/`: the `CourierApi` port, its Zod response schemas, the HTTP adapter (`ROUTES` lists
  every path in one place) and the mock adapter.
- `src/domain/`: framework-free rules: the courier's step per delivery status, the cold-chain
  check, the offer countdown, money and distance formatting, the map deep link.
- `src/location/`: background location (expo-location + expo-task-manager) and permissions.
- `src/session/`: the session token in expo-secure-store.
- `src/push/`: offer pushes (expo-notifications) behind a `PushService` port, and the hook that
  registers the device.
- `src/platform/clock/`: the only reader of the wall clock; everything else takes a `Clock`.
- `src/i18n/en.json`: every piece of copy, including the native permission texts that
  `app.config.ts` reads.

## Look and feel

The "Night Drive" design the owner chose on 2026-10-25 (direction A, with the always-visible
cold-chain strip of direction C).

- `src/ui/theme.ts` holds a light and a dark palette with the same keys; the app follows the
  phone's light or dark setting. Screens read colours through `makeStyles` or `useTheme`, never
  as literals. `test/ui-kit.spec.tsx` keeps every text colour at WCAG AA contrast in both.
- Steps that cannot be taken back (accept an offer, arrived at pickup, picked up, arrived at
  drop-off) use `SlideToConfirm`, so a tap in a moving car does not record them. Screen readers
  confirm with the activate action; tests use `slide()` from `test/render.tsx`.
- A chilled or frozen job shows `ColdStrip` at the top: the limit and the last reading this phone
  recorded.
- The main action of a screen sits in the `Screen` footer, within thumb reach.
- Next: a live map behind the home and job screens (needs the Google Maps key).

## Languages

The app speaks the device's language when it has it, and English otherwise (`src/i18n`). The
language is read once at start; a key a translation lacks falls back to English. English is the
only language so far. To add one: a `<code>.json` next to `en.json` with the same keys, one entry
in `LOCALES` (`src/i18n/locales.ts`, with `direction: 'rtl'` for Arabic, Persian or Urdu, which
mirrors the layout from the next start), and the native permission texts in `app.config.ts`.
`test/locales.spec.ts` checks every language file against English (no extra keys, the same
`{{placeholders}}`). Money and dates are formatted in the Market's locale, not the language.

Hard-coded copy is caught twice: `test/hard-coded-copy.spec.ts` reads every component for text
between JSX tags and literal labels, and `test/pseudo-locale.spec.tsx` renders the screens in
pseudo-English (`⟦Ĝö öñļîñé⟧`), where any plain word that is not API data fails. On Android,
choosing the developer locale "English (XA)" shows a development build in pseudo-English.

## Rules the app keeps

- No Market value in code: currency, locale, distance unit, support phone, offer timeout and
  cold-chain limits come from the API (`CourierSettings`). Lint enforces the Market-literal and
  wall-clock rules in `src/`.
- Money is minor units as decimal text plus an ISO 4217 code; the currency's digits come from
  `Intl`, never from the app.
- The session token is in the keystore (Keychain / Android Keystore), device-only, never in
  AsyncStorage. Sign-out deletes it and the online flag.
- Location is sent only while the courier is online: going offline stops the updates first, and
  the background task itself stops them when the online flag or the session is gone. No
  coordinates are logged.
- The proof photo comes from the camera only, is resized to 1280 px and re-encoded as JPEG,
  which also drops its EXIF block (GPS, device). The PIN is sent to the server to check; the app
  never knows the right PIN.
- A 401 signs the courier out and stops background location, also inside the background task.
  Going offline stops location on the device before the server is told.
- Route ids are checked against the API's id format before they go into a path.

## Backend contract

- Identity: `POST /identity/courier/sign-in` (email and password) and `…/sign-out`; bearer token.
- Delivery: `GET /delivery/courier/deliveries/:id` and `POST …/:id/events`. `delivered` takes
  `proof: { kind: 'pin', pin }` (the server checks it; its length is the Market's, the app takes
  4 to 8 digits) or `{ kind: 'photo', photoRef }` from `POST …/:id/proof-photos` (multipart part
  `photo`, JPEG, at most 5 MB, `201 { photoRef }`). A wrong PIN answers 422
  `delivery.pin-wrong`; 423 `delivery.pin-locked` closes PIN entry and the app switches to the
  photo.
- Tracking: `POST /tracking/courier/pings` (`{ pings: [...] }`, at most 20; the courier is the
  session's, so no ping carries a courier id).
- Dispatch: `GET /dispatch/courier/offers/current`, `POST …/:id/accept` (`{ deliveryId }`) and
  `…/:id/decline` (204). Before accept an offer names only the suburb and postcode of each stop (`{ suburb | null, postcode, point }`, Security L3) and `earnings: Money | null` (an estimate before waiting time, shown as "about"; null for an employee, a courier with no payee profile or a vehicle without a rate, shown as "pay unavailable", never zero). The drop-off point is snapped to a grid and is never used to navigate. The full address comes with the job after accept.

- Fleet: `GET /fleet/courier/me` (`{ shift, activeDeliveryId, … }`; 404 `fleet.courier.not-found`
  before an operator sets up the profile), `PUT …/me/shift { state }` (409
  `fleet.shift.active-delivery` mid-delivery, 422 `fleet.courier.*` when the courier may
  not work) and `GET …/me/settings` (the Market's courier settings). Fleet reports
  the real `activeDeliveryId`; the app also keeps the delivery it accepted in the secure
  store (with the session) as a fallback while fleet has not caught up, until the job ends or
  answers 404; once fleet names a different delivery the device copy is dropped.
- Payouts: `GET /payouts/courier/me/summary` (`{ today, week, deliveriesToday }` in the
  Market's time zone, the week from Monday) and `GET …/me/balance?limit=20` (`{ balance:
  { amount, tax, total }, entries }`, newest first; amounts are signed, a payout is negative).
  The Earnings screen shows both; an entry kind the app does not know shows as "Other".

- Notifications: `PUT /notifications/courier/me/push-device { token, platform }` (an Expo push
  token, `ios` or `android`) when the home screen opens with a session and each time the app
  returns to the foreground (the server drops a courier's devices when identity ends sessions),
  and `DELETE` on sign-out before the session ends. An offer push carries only
  `{ kind: 'offer', offerId }`: the app brings the home screen forward and fetches the current
  offer, once per offer id (a push can arrive twice).

Offers are polled every 5 s while online, or every 30 s once this device gets offer pushes (the
poll stays as the fallback). Push tokens need the EAS project id in the app config (release
builds); without it, or on a simulator or with notifications refused, the app just polls. A stop without a point
(not geocoded) is navigated to by its address.

Release builds (EAS profiles, the CI preview APK, store listing and what the owner must provide):
[RELEASE.md](RELEASE.md).

## Onboarding (handoff 38)

After sign-in the app opens `/onboarding`, a gate that sends an active courier straight home.
A new courier goes through four steps, each derived from the server's profile, so the app keeps
no progress of its own and resumes at the right step after a restart or on another phone:

1. Profile: employment type, service area and cold chain (`POST /fleet/courier/me`).
2. Vehicle: type and plate (`POST …/me/vehicles`); the capacity is the rate card's default.
3. Documents: the Market's required types for this courier (`POST …/me/documents`, multipart
   `file` + `type`, `vehicleId?`, `expiresAt?`), from the camera or the phone's files (PDF,
   JPEG, PNG, at most 10 MB). Images are re-encoded as JPEG, which drops EXIF; the local copy is
   deleted after the upload, on replace, on cancel and when the form closes, and the picker's
   cache folder is swept when onboarding opens.
4. Waiting for an operator (polled every 30 s). A contractor sets up payouts on the provider's
   page in the system browser (`POST /payouts/courier/me/onboarding-link`, https only).

The Market's rules (service areas, vehicle classes, documents, business id type) come from
`GET /fleet/courier/me/settings`. While the API does not send them, a new courier is asked to call
support. In the mock, an email starting with `new` signs in as a courier who has not applied;
the mock's operator approves everything submitted 10 s after the last upload.
