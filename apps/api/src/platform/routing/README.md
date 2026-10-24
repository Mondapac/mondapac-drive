# platform/routing

Road distance, travel time (ETA) and geocoding for every module, behind one port:
`ROUTING_PROVIDER` (`RoutingProvider`, exported from `index.ts`). Handoff 12.

- `route(market, origin, destination, vehicle)` and `matrix(...)` never fail. The answer's
  `source` is `road` (Google Routes API) or `straight_line` (great-circle distance times the
  Market's road factor, at the vehicle's typical speed). The fallback is used when the Market has
  no road provider or key, on a timeout or error, while the circuit breaker is open, and when the
  provider finds no road.
- `geocode(market, { address, postcode? })` restricts the search to the Market's country (and
  postcode). An address that is not found falls back to the postcode's centre
  (`precision: 'postcode'`). There is no offline fallback: an outage throws
  `GeocodingUnavailableError`.
- Configuration is the Market file's `routing` section (`routing-config.ts`): provider, the name of
  the API key's environment variable, region, travel mode per vehicle, timeout, breaker, cache TTL
  and coordinate rounding, and the straight-line speeds. No section: straight line only.
- Road routes are cached by Market, vehicle and rounded coordinates, in Redis when `REDIS_URL` is
  set (keys `routing:route:v1:<MARKET>:<sha256>`; the coordinates are hashed), else in process.
- Coordinates, addresses and the key are never logged; logs carry the Market and a code.
- Tests run against a local fake of the Google APIs (`test/support/fake-google-maps-server.ts`).
