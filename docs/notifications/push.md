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

A device is pushed to only while the session that registered it lives:

- At every push, notifications asks identity which of the devices' sessions are still live. This
  uses `IdentityFacade.liveSessionsOf`, which has the system rule and checks for revoked, past the
  absolute expiry, or idle sessions. A device of an ended session gets no push and is dropped. This
  covers ends with no `DELETE` and no event: an idle timeout, the absolute expiry, a sign-out while
  offline, and an uninstall.
- `DELETE` on sign-out drops the device at once. The app calls it before identity's sign-out.
- `expires_at` (registration plus the Market's courier session absolute lifetime,
  `identity.sessions.courier.absoluteLifetimeMinutes`) bounds the row as a second line.
- When identity ends an account's sessions, every device of that account is dropped. The events
  are `identity.account-disabled.v1`, `identity.account-password-changed.v1` and
  `identity.account-other-sessions-signed-out.v1`. The app of a session that is still alive gets
  its device back with the `PUT` at its next start.
- A device Expo answers `DeviceNotRegistered` for is dropped.
- A token that another courier's session registers moves to that courier. This happens when two
  couriers share a phone, and only the courier signed in on the phone receives its pushes. A
  courier who copied another's token could take its pushes this way; that needs the other phone's
  token, and the move is visible as the first courier missing pushes (Hassan L1, accepted).

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
- If identity cannot answer the session check, the use case refuses and the event is retried.
- If some devices took the push and others failed, the event is handled and the failed devices miss
  this offer. The courier still sees it in the app (Hassan L3, accepted).

## Storage and keys

`notifications.push_devices` stores the token sealed and never in clear:

- `token_sealed`: AES-256-GCM, with the Market and the account id as associated data.
- `token_lookup`: the HMAC-SHA256 of the token, unique per Market.

Both keys are derived with HKDF from `NOTIFICATIONS_WEBHOOK_KEY`. Rotating that key makes every
stored token unreadable. Such rows are skipped, and apps register again at their next start.
The application role may select, insert and delete rows, never update them.

## Environment

- `EXPO_ACCESS_TOKEN`: Expo's access token, kept in the secrets store and never logged. Turn on
  Expo's enhanced push security for the project so that only calls with this token are accepted.
  When it is unset, no push is sent, and a warning `notifications.push.disabled` is logged at
  start-up.

Stored tokens are treated as personal data. They are never logged or answered, and they are
dropped with the courier's sessions.
