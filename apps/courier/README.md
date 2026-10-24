# Courier app

React Native app for Mondapac Drive couriers: Expo SDK 58 (managed workflow), TypeScript strict,
expo-router, TanStack Query and Zod. Phase 1 slice 6 (`docs/plan.md`, handoff 08).

## Run it

```sh
pnpm install
pnpm --filter courier start:mock          # Expo Go / simulator, on the in-app mock backend
EXPO_PUBLIC_API_URL=https://… pnpm --filter courier start   # against a real API
```

Without `EXPO_PUBLIC_API_URL` the app always uses the mock (`src/api/mock`). The mock accepts any
6-digit sign-in code, offers the two fixture jobs in turn and takes the delivery PIN `1234`.
`EXPO_PUBLIC_API_URL` must be https, except for localhost and LAN addresses.

Web (`expo start --web`) is a screen preview only: no background location, and the session is
kept in memory (`*.web.ts` files).

## Checks

`pnpm --filter courier typecheck` and `pnpm --filter courier test` (Jest, jest-expo and React
Native Testing Library). Both run in `pnpm verify` and CI through `pnpm -r`, and the root
`pnpm lint` lints the app. Rule tests run on AU and the synthetic ZZ Market, built from
`config/markets/AU.json` and `test/fixtures/markets/ZZ.json`.

## Layout

- `src/app/`: routes (expo-router). Thin: each wires a screen to the router.
- `src/screens/`, `src/components/`, `src/ui/`: screens, their parts and the base widgets.
- `src/api/`: the `CourierApi` port, its Zod response schemas, the HTTP adapter (`ROUTES` lists
  every path in one place) and the mock adapter.
- `src/domain/`: framework-free rules: the courier's step per delivery status, the cold-chain
  check, the offer countdown, money and distance formatting, the map deep link.
- `src/location/`: background location (expo-location + expo-task-manager) and permissions.
- `src/session/`: the session token in expo-secure-store.
- `src/platform/clock/`: the only reader of the wall clock; everything else takes a `Clock`.
- `src/i18n/en.json`: every piece of copy, including the native permission texts that
  `app.config.ts` reads.

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

## Backend contract

Only the delivery routes exist on main (`GET /delivery/deliveries/:id`,
`POST /delivery/deliveries/:id/events`, with `x-market-id`). The other paths in
`src/api/http-client.ts` are proposals for the packages that own them and change there:

| Port                               | Owner        | Proposed route                                     |
| ---------------------------------- | ------------ | -------------------------------------------------- |
| Sign in / out                      | identity WP2 | `POST`/`DELETE /identity/courier/sessions…`        |
| Market settings, status, shift     | fleet 05     | `GET /fleet/courier/me…`, `PUT …/me/shift`         |
| Location pings                     | tracking 06  | `POST /tracking/courier/pings` `{ pings: [...] }`  |
| Current offer, accept, decline     | dispatch 07  | `/dispatch/courier/offers/current`, `…/:id/accept` |
| Proof photo upload                 | delivery     | `POST /delivery/deliveries/:id/proof-photos`       |
| Earnings summary                   | payouts 10   | `GET /payouts/courier/me/summary`                  |

Two changes the delivery API needs for the courier: the `delivered` event takes
`proof: { kind: 'pin', pin }` and the server checks the PIN (today the body carries
`pinMatched: true`, which a client could assert), and a proof-photo upload route that returns
the `photoRef`. Offers are polled every 5 s while online until dispatch pushes them.

Store builds (EAS: identifiers, icons, signing, push) are a later package.
