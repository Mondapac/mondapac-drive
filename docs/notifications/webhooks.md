# Delivery webhooks and recipient SMS

The notifications module (`apps/api/src/modules/notifications`) tells merchants about their
deliveries through signed webhooks and tells recipients through SMS. Both are queued in
PostgreSQL (schema `notifications`) when a delivery changes and sent by two worker jobs,
`notifications.webhook-dispatch` and `notifications.sms-dispatch`, every 10 seconds per Market.

## Webhook format (shared with the marketplace carrier adapter)

`POST` to the subscription's HTTPS URL, body `application/json`:

```json
{
  "id": "<event id, UUIDv7>",
  "type": "delivery.booked | delivery.status-changed | delivery.cancelled",
  "occurredAt": "2026-11-02T00:00:00Z",
  "marketId": "AU",
  "data": {
    "deliveryId": "<uuid>",
    "externalReference": "<merchant's reference, e.g. the sub-order id>",
    "status": "PICKED_UP",
    "previousStatus": "AT_PICKUP",
    "reason": "<code, optional>"
  }
}
```

Headers:

| Header             | Value                                                      |
| ------------------ | ---------------------------------------------------------- |
| `Drive-Timestamp`  | Unix seconds of this attempt                               |
| `Drive-Signature`  | `v1=<hex>`; more than one `v1=` entry may appear, comma separated |
| `Drive-Event-Id`   | the body's `id`: the receiver's deduplication key          |
| `Drive-Event-Type` | the body's `type`                                          |

`<hex>` is the lowercase hex HMAC-SHA256 of `<Drive-Timestamp>.<raw body bytes>` under the
subscription's secret. A receiver must:

1. parse `Drive-Timestamp` as a plain integer and refuse it when it is more than 300 s away from
   its own clock (replay window);
2. compute the HMAC over the raw body exactly as received (before any JSON parsing);
3. accept when any `v1` entry equals it, compared in constant time;
4. deduplicate on `Drive-Event-Id`: a retry or an operator re-send repeats the same id and body.

The reference implementation is `verifyWebhookSignature` in
`infrastructure/hmac-webhook-signer.ts`. Delivery is at least once and in no guaranteed order;
compare `occurredAt` or the status sequence before applying a change.

## Secrets

A subscription's secret is never stored. It is
`base64url(HMAC-SHA256(NOTIFICATIONS_WEBHOOK_KEY, "drive.webhook-secret.v1:<subscription id>:<version>"))`,
shown to the merchant once when the subscription is created or its secret rotated. Rotation adds
one to the version; the old secret stops working at once. `NOTIFICATIONS_WEBHOOK_KEY` (base64,
at least 32 random bytes) is required outside an explicit `development` or `test` run.

## Retries and dead letters

Any answer other than 2xx, a timeout (10 s) or a network failure is retried after
`firstRetrySeconds`, doubling up to `maxRetrySeconds`, for `maxAttempts` attempts in all
(`notifications.webhooks` in the Market file). `410 Gone`, a URL that resolves to a private
address and a disabled subscription dead-letter at once. An operator re-sends a dead call
(`ResendWebhookCall`): same id and body, a fresh count of attempts. An attempt that throws is
recorded as a retryable `notifications.internal` failure, and a message whose attempts ran out
without a recorded outcome is dead-lettered rather than claimed again.

## SSRF controls

Subscription URLs are HTTPS on port 443 or 8443, without credentials or fragment, and not a
private IP or internal name. On every attempt the host is resolved and every address must be public (no private,
loopback, link-local, CGNAT, documentation, multicast or reserved range, IPv6 outside global
unicast, or an IPv4-mapped, NAT64 or 6to4 address of one); the connection goes only to a checked
address. Redirects are not followed; at most 4 KB of an answer is read.

## Recipient SMS

`booked` (with the tracking link), `on_the_way` (picked up), `delivered` and `failed`, from the
Market's templates in `notifications.sms`, which may name only `{reference}` and
`{trackingUrl}`; the opt-out text is appended. The merchant reference is cut to 32 characters of
`A-Z a-z 0-9 - _ #`, so it can never become a link. Only numbers with one of the Market's
`allowedCallingCodes` get an SMS (SMS pumping control); enable Twilio Geo Permissions to match. The recipient's number is read from the delivery at each attempt and handed only
to the SMS provider (Twilio, `TWILIO_ACCOUNT_SID` and `TWILIO_AUTH_TOKEN`); no number or message
text is stored or logged. Without Twilio settings every SMS fails and is retried until it dies.

## Not wired yet

- Source events: `delivery.booked`, `delivery.status-changed`, `delivery.cancelled` are added to
  the delivery outbox by package 07 after WP2; a subscriber then calls `RecordDeliveryChange`.
- The recipient's number (delivery, after WP2) and the tracking link (package 06) are stand-ins
  that answer nothing until those modules expose them.
- Routes for subscription management and the operator re-send arrive with the WP2 gate, as do
  the audit records of those actions.
