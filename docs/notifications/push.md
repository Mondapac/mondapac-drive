# Courier push for offers

The notifications module pushes each new dispatch offer to the courier's phone through Expo's push
service (handoff 33). Webhooks to merchants are in [webhooks.md](webhooks.md).

## Registering the device

The courier app calls, with the courier's bearer session:

| Route | Body | Answer |
| --- | --- | --- |
| `PUT /notifications/courier/me/push-device` | `{ token, platform }` | 204 |
| `DELETE /notifications/courier/me/push-device` | none | 204, also when there is no device |

- `token` is an Expo push token, `ExponentPushToken[...]` or `ExpoPushToken[...]`; anything else
  answers 400 `push-device.invalid-token`. `platform` is `ios` or `android`.
- Permission `notifications.push-device.manage` (courier scope; the courier system role holds it).
  The courier and the session come from the bearer token, never from the body.
- One device per session: a second `PUT` replaces the first. A token held by another session
  moves to this one (the same phone signed in again).
- The app calls `PUT` after sign-in and at every start, and `DELETE` on sign-out.

## How long a device lives

A device never outlives the session that registered it:

- `DELETE` on sign-out drops it.
- It is never pushed to after `expires_at`, which is the registration time plus the Market's courier
  session absolute lifetime (`identity.sessions.courier.absoluteLifetimeMinutes`).
- When identity ends an account's sessions, every device of that account is dropped. The events
  are `identity.account-disabled.v1`, `identity.account-password-changed.v1` and
  `identity.account-other-sessions-signed-out.v1`. The app of a session that is still alive gets
  its device back with the `PUT` at its next start.
- A device Expo answers `DeviceNotRegistered` for is dropped.

An idle-timed-out session keeps its device until one of the above happens. Identity has no event
for an idle timeout. The push names nothing personal, and opening the offer needs a live session.

## The push

The subscriber `notifications.offer-push` consumes `dispatch.offer-sent.v1`. The offer id is the
envelope's aggregate id, and `courierId` is the identity account id. It pushes to the courier's
live devices (at most 10):

- `title` and `body` come from Market config `notifications.push`: `offerTitle` and `offerBody`.
  The body names `{seconds}` exactly once. For AU it reads "New offer, expires in N s".
- `data` is `{ kind: 'offer', offerId }`. It holds no address, recipient or merchant. The app
  fetches `GET /dispatch/courier/offers/current` when the courier opens the push.
- `ttl` is the number of seconds left, so Expo never delivers the push after the offer expires.
  Priority is high.
- An offer with less than a second left is not pushed.

## Failures

The push is sent before the inbox unit, because no external call runs inside a unit. These are
the outcomes:

- At least one device took the push: the event is handled.
- Nothing went out and a failure may pass (429, 5xx, a network error, `MessageRateExceeded`): the
  use case refuses. The event is retried through the inbox and, after its last attempt,
  dead-lettered. Gone devices are dropped first.
- Any other failure is final for that push.
- If the process crashes between the send and the inbox commit, the redelivered event pushes again.
  The app removes the duplicate by `offerId`.

## Storage and keys

`notifications.push_devices` stores the token sealed and never in clear:

- `token_sealed`: AES-256-GCM, with the account id as associated data.
- `token_lookup`: the HMAC-SHA256 of the token, unique per Market.

Both keys are derived with HKDF from `NOTIFICATIONS_WEBHOOK_KEY`. Rotating that key makes every
stored token unreadable. Such rows are skipped, and apps register again at their next start.
The application role may select, insert and delete rows, never update them.

## Environment

- `EXPO_ACCESS_TOKEN`: Expo's access token. It is needed when the Expo project enforces push
  security. When it is unset, no push is sent, and a warning `notifications.push.disabled` is logged
  at start-up.
