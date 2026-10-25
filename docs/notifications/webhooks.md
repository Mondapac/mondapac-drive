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
one to the version. For the Market's `notifications.webhooks.rotationOverlapMinutes` after a
rotation every call carries two `v1=` entries, the new secret's first and the previous one's,
so the merchant can switch its receiver without losing a call; then only the new one. A second
rotation inside the overlap ends the oldest secret at once, so at most two entries are ever sent
(the marketplace accepts up to four). `NOTIFICATIONS_WEBHOOK_KEY` (base64, at least 32 random
bytes) is required outside an explicit `development` or `test` run, and wherever Twilio
credentials are set. Without it such a run derives a local stand-in from a constant and its
`DATABASE_URL`, so the source alone does not reproduce it.

## Routes

Merchant (`Authorization: Bearer <merchant API key>`, `x-market-id`), always the key's own
subscriptions; another merchant's answers 404:

| Route | Permission |
| --- | --- |
| `POST /notifications/webhook-subscriptions` `{url, eventTypes}`: answers the secret once | `notifications.webhook.manage` |
| `GET /notifications/webhook-subscriptions`: newest first, no secrets | `notifications.webhook.view` |
| `PUT /notifications/webhook-subscriptions/:id/event-types` `{eventTypes}` | `notifications.webhook.manage` |
| `POST /notifications/webhook-subscriptions/:id/rotate-secret`: answers the new secret once | `notifications.webhook.manage` |
| `POST /notifications/webhook-subscriptions/:id/disable` | `notifications.webhook.manage` |

Admin panel (session cookie, CSRF on POST), key `notifications.webhook-call.resend` (platform;
the Platform Administrator and the default operator role, seed v5, hold it):

- `GET /notifications/admin/webhook-calls/dead`: dead-lettered calls, ids and codes only;
- `POST /notifications/admin/webhook-calls/:id/resend`.

Every change is audited (`notifications.webhook-subscription.created`, `.event-types-changed`,
`.secret-rotated`, `.disabled`, `notifications.webhook-call.resent`), without URL or secret.

## Retries and dead letters

Any answer other than 2xx, a timeout (10 s) or a network failure is retried after
`firstRetrySeconds`, doubling up to `maxRetrySeconds`, for `maxAttempts` attempts in all
(`notifications.webhooks` in the Market file). `410 Gone`, a URL that resolves to a private
address and a disabled subscription dead-letter at once. An operator re-sends a dead call
(`ResendWebhookCall`, the admin route above): same id and body, a fresh count of attempts. An attempt that throws is
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
`{trackingUrl}`; the opt-out text is appended. The booked message also carries the delivery's
proof-of-delivery PIN, when it has one, through the Market's `pinText` (which names `{pin}`); the
PIN must be 4 to 8 digits and appears in no other message. The tracking link is
`trackingPageUrl` with a token tracking issues at each attempt (`IssueTrackingLink`); while the
delivery is not tracked yet the SMS is retried. The merchant reference is cut to 32 characters of
`A-Z a-z 0-9 - _ #`, so it can never become a link. Only numbers with one of the Market's
`allowedCallingCodes` get an SMS (SMS pumping control); enable Twilio Geo Permissions to match. The recipient's number and PIN are read from the delivery at each attempt
(`DeliveryRecipients.forNotification`) and handed only to the SMS provider (Twilio, `TWILIO_ACCOUNT_SID` and `TWILIO_AUTH_TOKEN`); no number, PIN or message
text is stored or logged. Without Twilio settings every SMS fails and is retried until it dies.

## Source events

Subscriptions `notifications.delivery-booked`, `notifications.delivery-status-changed` and
`notifications.delivery-cancelled` consume `delivery.booked.v1`, `delivery.status-changed.v1` and
`delivery.cancelled.v1` (ids and codes only) and call `RecordDeliveryChange` as the Market's
system actor. It reads the merchant and its `externalReference` from the delivery module, then
queues in one `runOnce` unit with the `notifications.inbox` row, so a repeated event queues
nothing. Event statuses are lower-case codes (`picked-up`); the webhook body names them as the
delivery API does (`PICKED_UP`). An event of a delivery the delivery module does not know is
refused and retried.
