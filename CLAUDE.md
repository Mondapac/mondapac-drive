# Project: Mondapac Drive

Fleet management and last-mile delivery for the Mondapac halal marketplace (Australia first,
Greater Brisbane). Sister repository of Mondapac/mondapac-marketplace-platform; follow the same
conventions (docs/adr/0001).

## Rules

- Modular monolith in `apps/api` (NestJS). Each module: presentation -> application -> domain
  -> infrastructure; modules talk only through public interfaces or events.
- Domain code is framework-free and takes time from the injected Clock (`platform/clock`);
  `new Date()` and `Date.now()` are lint errors outside it.
- No Market literal (AU, AUD, Brisbane, ...) in core code: it goes in `config/markets/<CODE>.json`.
- Money is integer minor units plus an ISO 4217 currency, never a float.
- Tests run against AU and the synthetic ZZ market (`test/fixtures/markets/ZZ.json`). A rule
  that only passes for AU is a bug.
- One Prisma schema file per module; every migration has a `down.sql`.
- Run `pnpm verify` before opening a pull request.
- The project owner writes in Persian; replies to them are in Persian, code and docs in English.
