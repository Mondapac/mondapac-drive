# Courier offers (dispatch)

The courier app's offer routes. Population `courier`, `Authorization: Bearer <session token>`.
The courier is always the session's account, never a path or body field.

## `GET /dispatch/courier/offers/current`

Key `dispatch.offer.view`. The courier's open offer that expires first, or `{ "offer": null }`.

```json
{
  "offer": {
    "id": "<offer id>",
    "deliveryId": "<delivery id>",
    "expiresAt": "2026-11-02T08:00:30Z",
    "pickup": { "address": "1 Pickup Street", "point": { "lat": -27.47, "lng": 153.02 } },
    "dropoff": { "address": "2 Dropoff Road", "point": { "lat": -27.5, "lng": 153.05 } },
    "distanceMetres": 4200,
    "temperature": "chilled",
    "earnings": { "amount": "1361", "currency": "AUD" }
  }
}
```

`earnings` is `Money | null`, the payouts wire shape: `amount` is integer minor units as
decimal text (AUD has 2 decimals, JPY none; format with the Market's currency digits).

- It is what payouts will credit the courier's balance for this delivery: the Market's rate
  for the vehicle the delivery was quoted for, the distance and the cold-chain bonus, plus the
  tax Drive adds for a registered contractor (AU: GST). It comes from payouts' `EarningsQuote`,
  which uses the same rates and fleet payee profile as the `payouts.delivery-earning`
  subscriber, so the offer equals the recorded earning.
- Waiting time is not known before the delivery and is not quoted; the recorded earning may be
  higher by the waiting pay once delivery reports waiting time.
- `null` for an employee (paid through payroll), a courier fleet has no payee profile for, a
  vehicle the Market has no courier rate for, or when fleet could not be read. The offer is
  still shown.

## `POST /dispatch/courier/offers/:id/accept` and `/decline`

Key `dispatch.offer.answer`, empty body. Accept answers 200 `{ deliveryId }`; decline answers
204. Errors: 404 `offer.not-found` (also another courier's offer), 409 `offer.not-pending`,
410 `offer.expired`, 409 `dispatch.conflict` on a race (fetch again), 400 `validation.failed` for
a non-empty body.

## Events

Each offer sent publishes `dispatch.offer-sent.v1 { jobId, deliveryId, courierId, round,
expiresAt }` from the dispatch outbox (aggregate `dispatch-offer`, aggregate id = the offer id,
courier id = the identity account id). Notifications sends the offer push from it.
