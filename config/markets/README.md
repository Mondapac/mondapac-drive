# Market configuration

One JSON file per Market, validated at start-up (`apps/api/src/platform/market-config`). Core code
never names a Market; everything that differs by Market lives here.

- Money values are integer minor units of `currency`.
- `rateCard` values are **placeholders** until the unit economics are agreed (see the plan doc).
- `serviceAreas` mirror the marketplace's `config/service-areas/<CODE>.json`; postcode entries are
  single codes or inclusive ranges.
- `coldChain` holds the highest temperature a reading may show at pickup and drop-off.
