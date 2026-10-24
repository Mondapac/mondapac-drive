# Plan

The product and technical plan (roles, features, architecture, roadmap, Australian market notes,
marketplace integration) is kept as a living document:
https://claude.ai/artifact/3J6JVcXaVKBFWfCQqR1ciq

## Decisions so far (2026-10-24)

| Topic | Decision |
| --- | --- |
| Market | Australia, starting in Greater Brisbane |
| Fleet | Hybrid: a core of fixed couriers plus gig couriers |
| MVP scope | All vehicles (bicycle, motorbike, car, van); on-demand and scheduled |
| Stack | NestJS, Next.js, PostgreSQL + PostGIS, Redis, React Native (Expo) |
| Repository | Separate (ADR-0001) |

## Phase 1 slices

1. **Delivery core (this slice):** quotes, booking, lifecycle with cold chain and proof of
   delivery, Market config, service areas. In-memory store.
2. PostgreSQL repository over `prisma/schema/delivery.prisma`, outbox, status webhooks.
3. Authentication: merchant API keys, courier sessions, dispatcher accounts.
4. Couriers and vehicles: onboarding, documents (ABN, licence, insurance), online state, live
   location in Redis GEO.
5. Dispatch: offer to nearest eligible couriers, accept timeout, manual assignment.
6. Courier app (Expo): go online, accept, navigate, readings, PIN or photo proof.
7. Dispatcher panel (Next.js): live map, exceptions.
8. Marketplace carrier adapter (in the marketplace repository, SHP-02/03).
9. Payouts with Stripe Connect; routing adapter (Google Routes or Mapbox) instead of the
   straight-line estimate.
