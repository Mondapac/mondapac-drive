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

## Speed and cost mode (docs/process/speed-mode.md)
Adopted from the marketplace from day one. In short: cheaper model for coding, CI is the main
gate, one combined QA + QC review per batch, one complete feature per PR, no design documents
ahead of code, one fresh session per work package with a 5 KB handoff, reuse marketplace code
before building.

## Security paths (security-tester review is mandatory before merge)
Authentication and authorisation, payments and courier payouts, live location and other personal
data (Privacy Act), proof of delivery and cold-chain records, webhooks to and from the
marketplace, raw SQL. Everything else relies on CI and the combined review.

## Team (subagents in .claude/agents/)
The same 13 roles and names as the marketplace (see its CLAUDE.md and TEAM-PLAYBOOK-fa.md):
Ali (cto), Hadi (product-owner), Mohammad (software-architect), Mojtaba (database-designer),
Jafar (product-designer), Reza (ui-ux-designer), Hossein (backend-developer), Mahdi
(frontend-developer), Sajad (qa-engineer), Hassan (security-tester), Bagher
(qc-release-manager), Kazem (devops-engineer), Javad (scrum-master). The owner is addressed as
«صاحب پروژه».
Agent files were copied from the marketplace. Where one names marketplace-only rules
(CERT-*, catalog, pricing Cost, Figma-first, G1/G2 gates), read them as the Drive equivalents
in this file; speed mode overrides the gate and review steps they describe.
Flow: product-owner -> software-architect (+ database-designer for schema) -> backend or
frontend developer -> CI -> combined qa + qc review per batch; security-tester for the paths
above; cto settles disagreements.

## Definition of Done (every PR)
- `pnpm verify` green; migrations reversible (CI round trip).
- Tests on AU and ZZ; domain rules tested first.
- Input validated; authorisation checked once authentication exists.
- `docs/` note only if behaviour or architecture changed.
