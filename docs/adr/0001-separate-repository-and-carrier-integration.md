# ADR-0001: Separate repository, same conventions, marketplace integration as a carrier

**Status:** Accepted (2026-10-24, chosen by the project owner)

## Context

Mondapac Drive is a fleet and last-mile delivery platform. Its first customer is the Mondapac
marketplace ([Mondapac/mondapac-marketplace-platform](https://github.com/Mondapac/mondapac-marketplace-platform)),
whose shipping is today only SHP-01: the seller types a carrier name and tracking code by hand.
The marketplace already plans SHP-02..05 (real carriers with label, pickup and tracking) and a
`real_time_delivery` FulfillmentStrategy. Later, Drive should also serve merchants outside the
marketplace, as Uber Direct and DoorDash Drive do.

## Decision

1. Drive lives in its own repository, `Mondapac/mondapac-drive`, with its own release cycle.
2. It follows the marketplace's conventions so one team can work in both: NestJS modular
   monolith, Prisma 7 with one schema file per module and a `down.sql` per migration, PostgreSQL
   (with PostGIS here) and Redis, pnpm workspaces, Node 24, Next.js panels, money as integer minor
   units plus currency, Market configuration as code, no Market literal in core code, tests on
   AU plus a synthetic second Market (ZZ), the injected Clock as the only time source.
3. The marketplace talks to Drive like any carrier: it asks for a quote, books with its
   sub-order id as `externalReference` (idempotent), and receives status webhooks. Drive's
   "delivered" event, backed by proof of delivery, can then set the marketplace's Delivered state.
4. The courier app is React Native (Expo) in TypeScript, so it can share types with the API.

## Consequences

- The marketplace gets a Drive carrier adapter in its `shipping` module (SHP-02/03), owned there.
- Identity is not shared at first: Drive issues merchant API keys and courier sessions itself.
- A shared npm package for kernel types may come later; for now each repository has its own.
