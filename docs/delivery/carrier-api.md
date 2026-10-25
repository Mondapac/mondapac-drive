# Delivery carrier API (what the marketplace calls)

The marketplace's real-time carrier integration (marketplace
`docs/modules/shipping/carrier-mondapac-drive.md`, handoff 09b) calls two delivery routes with a
merchant API key (`Authorization: Bearer mk1_...`) and the Market header (`x-market-id`):

| Route | Use |
| --- | --- |
| `POST /delivery/quotes` | Live price at checkout. The marketplace sends postcodes only, the postcode standing in as the address, and reads `total`. |
| `POST /delivery/deliveries` | Booking. Idempotent on (merchant, `externalReference`): a repeat answers 200 with the first delivery. |
| `POST /delivery/deliveries/:id/cancel` | Cancel; 409 when no longer cancellable. |

## Response time

The marketplace gives one attempt 2.5 s and makes at most two. Drive budgets **2 s at p95** for
a quote and a booking, geocoding included (`test/db/delivery-speed.db-spec.ts` measures it on
the real stack with a fake map provider at 120-420 ms latency: about 0.8-0.9 s at p95 in AU and
ZZ).

- **Geocoding** (stops sent without `point`) waits at most the Market's
  `delivery.responseBudget.geocodeMs` (AU 900 ms). Found points are kept in the API process for
  `geocodeCacheSeconds` (AU 24 h), keyed by an HMAC of the Market, the normalised address and the
  postcode under a per-process key, so no address is ever a cache key. Misses are not kept.
- **A slow geocode** answers `503 address.geocoding-unavailable` with `Retry-After: 2`. The lookup
  keeps running and fills the cache, and a request for the same address meanwhile joins it, so
  the retry is quick.
- **Road distance** waits at most `routeMs` (AU 700 ms). When routing is slower, down, or has no
  key, the quote uses the straight line times `estimateRoadFactor` (AU 1.3) and answers
  `distanceEstimated: true`. The price is still the price: a booking quoted from an estimate is
  priced again at booking (from the road distance when routing has answered by then), so a
  booking that sends `expectedTotal` may get `409 quote.price-changed`.

## Throttling and retries

- Every route is behind the platform's per-origin limiter (`requestLimits.defaultPerMinute`,
  AU 300 per minute per client address, counted across Markets). Over the limit the answer is
  `429 request.throttled` with `details.retryAfterSeconds` and a `Retry-After` header (seconds).
  The marketplace is one origin, and a checkout may quote up to 10 sellers: 300 per minute is
  about 30 checkouts a minute before quotes fall back to the flat fee.
- `Retry-After` is sent on `429 request.throttled` and `503 address.geocoding-unavailable`.
  Clients should wait at least that long before retrying.

## Quote bounds

The marketplace drops a quote outside its Market's `carrier.realTime.quoteBounds` (AU 500..10000
minor units, tax included) and charges its flat fee instead. The AU rate card stays inside the
bounds for every parcel a bicycle or motorbike carries, and for a car up to 56-60 km (by
temperature) and a van up to 31-34 km; see the handoff 34 result note for the table.
