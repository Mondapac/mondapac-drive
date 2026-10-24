# Market configuration

One JSON file per Market, validated at start-up (`apps/api/src/platform/market-config`, copied
from the marketplace). Core code never names a Market; everything that differs by Market lives
here. The marketplace's core fields (status, locales, currencies, time zone, tax, request limits)
are kept in the same shape; `delivery` is Drive's own section.

- Money values are integer minor units of `defaultCurrency`.
- `delivery.rateCard` values are **placeholders** until the unit economics are agreed (see the
  plan doc). A vehicle that is not listed is not offered in the Market.
- `delivery.coldChain` holds the highest temperature a reading may show at pickup and drop-off.
- `delivery.scheduling` bounds how early and how far ahead a delivery can be booked.
- Where a Market delivers is in `config/service-areas/<CODE>.json`, the same format as the
  marketplace's: postcode entries are single codes or inclusive ranges.
