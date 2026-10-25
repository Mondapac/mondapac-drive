# Courier app releases

Three build variants, one per EAS profile in `eas.json`. `app.config.ts` reads the variant and
the rest from the build's environment (`release/release-config.ts`) and refuses a preview or
production build that would start on the mock, on plain http, or for a Market without a
`config/markets/<CODE>.json`.

| Variant | Profile | Identifier | For | API |
| --- | --- | --- | --- | --- |
| development | `development` (dev client) | `com.mondapac.drive.courier.development` | developers | mock or any |
| preview | `preview` (internal, APK) | `com.mondapac.drive.courier.preview` | internal testers | the pilot API |
| production | `production` (store) | `com.mondapac.drive.courier` | couriers | the Market's API |

The three install side by side; the home-screen name says "(Dev)" or "(Preview)".

## Build environment

| Variable | Where it is set | Meaning |
| --- | --- | --- |
| `APP_VARIANT` | `eas.json` profile, or the CI job | `development` (default), `preview`, `production` |
| `EXPO_PUBLIC_API_URL` | EAS environment variables (per environment), or the CI variable `COURIER_PREVIEW_API_URL` | the API this binary talks to; https |
| `EXPO_PUBLIC_MARKET_ID` | EAS environment variables, or the CI variable `COURIER_PREVIEW_MARKET_ID` | the Market this binary serves |
| `APP_VERSION` | CI, from the tag `courier-vX.Y.Z` | marketing version; the package version otherwise |
| `APP_BUILD_NUMBER` | CI run number (preview); EAS increments it remotely for production | Android `versionCode`, iOS build number |
| `EAS_PROJECT_ID`, `EAS_OWNER` | repository variables, once the EAS project exists | links the config to the owner's EAS project |

One binary serves one Market and one API, so a second Market is a second set of EAS
environment values (or a second store app), never a code change.

## Preview builds in CI

`.github/workflows/courier-preview.yml` builds an Android preview APK with `expo prebuild` and
Gradle on every push to main that touches the app, on pull requests that change the build
files, on release tags, and on demand (Actions > Courier app builds > Run workflow). The APK is a
workflow artefact for 30 days. It is signed with the debug key: testers install it directly
(allow installs from unknown sources); it can never be uploaded to Play.

Locally: `APP_VARIANT=preview EXPO_PUBLIC_API_URL=https://… EXPO_PUBLIC_MARKET_ID=<code>
pnpm --filter @mondapac-drive/courier prebuild:android`, then `./gradlew assembleRelease` in
`apps/courier/android` (needs JDK 17 and the Android SDK). iOS needs a Mac or EAS.

## Store release

1. Tag the commit: `git tag courier-v1.0.0 && git push origin courier-v1.0.0`.
2. CI builds the preview APK for that version, then queues `eas build --profile production
   --platform all`, if `EXPO_TOKEN` and `EAS_PROJECT_ID` are set. Without them the job notes it in
   the run summary and stops.
3. Submit from EAS (`eas submit --profile production`): Android goes to the internal testing
   track as a draft; iOS goes to TestFlight. Promote by hand in each console.

## What the owner needs to provide (nothing is set yet)

| Item | Used for | Where it goes |
| --- | --- | --- |
| Expo account and an EAS project for the app | all EAS builds | repository variables `EAS_PROJECT_ID`, `EAS_OWNER`; secret `EXPO_TOKEN` (a robot token) |
| Apple Developer Program membership (organisation, D-U-N-S number) | iOS builds and the App Store | EAS manages the distribution certificate and provisioning profile once signed in; App Store Connect API key (`.p8`, key id, issuer id) stored in EAS for submit |
| Google Play developer account (organisation) | Android store builds | the upload keystore is generated and held by EAS; a Play service-account JSON key stored in EAS for submit; the first upload of an app must be done by hand in the Play console |
| Pilot API URL (https) and Market | preview and production builds | EAS environment variables per environment; CI variables `COURIER_PREVIEW_API_URL`, `COURIER_PREVIEW_MARKET_ID` |
| Privacy policy, support URL, demo courier account | store review | `store/listing.md` |
| Final logo | icon, splash, feature graphic | `store/assets/` |

No signing key, keystore or service-account file goes in the repository (`.gitignore` blocks the
common names).
