# Runbook: a payout line is unresolved or held

A payout run sends one Stripe Connect transfer per payout line. Each transfer carries the
idempotency key `payout-line-<lineId>`, `transfer_group = <runId>` and the metadata
`{marketId, payoutLineId, runId}`. This runbook covers the two cases where a line does not end
as `transferred` by itself.

| Status | Meaning | Courier's balance |
|---|---|---|
| `unresolved` | The transfer was sent, but Drive did not get a clear answer back (a timeout, a lost connection, a malformed answer, or an idempotency error after the retries ran out). Stripe may or may not have moved the money. | Debited (Drive assumes the money may have left). |
| `held` | The courier's connected account stopped taking payouts between planning and sending (L5), so the line was never sent. | Debit reversed (`payout-held`): the amount waits for the next run. |

The payout job logs the warnings `payouts.lines-unresolved` and `payouts.lines-held-at-sending`,
with the Market and the count, on each tick that leaves such lines. Both events and every settled line also reach the outbox
(`payouts.line-failed.v1` with `status: unresolved`, `payouts.line-transferred.v1`).

## Who can act

- **See** lines and balances: `payouts.ledger.view` (platform scope). The default operator role holds it
  (seed v5); grant it to anyone else through a custom platform role.
- **Settle** a line: `payouts.line.settle` (protected). Only a role an owner grants explicitly
  holds it. Every settle is audited (`payouts.line.settled`).

## 1. Find the lines

```
GET /payouts/admin/lines?status=unresolved            # default: held,unresolved
GET /payouts/admin/lines?status=held&courierId=<id>
```

The answer is `{lines, next?}` in id order, at most 200 per page (`limit`, `after=<next>`).
Each line has `id`, `runId`, `courierId`, `amount`, `status`, `failureCode`, `holdReason`
and its timestamps. The destination account is never shown.

## 2. Held lines: usually nothing to do

A held line is not money in doubt. The courier's balance already includes it again, and the
next run that finds the account enabled pays it in a new line. Check the courier's onboarding
state if lines keep being held for the same courier:

```
GET /payouts/admin/couriers/<courierId>/balance
```

Ask the courier to finish Stripe onboarding (the app's "Set up payouts" calls
`POST /payouts/courier/me/onboarding-link`).

## 3. Unresolved lines: settle against Stripe

Do not pay the courier by hand, and do not create a transfer in the Stripe dashboard. Either
action can pay twice.

```
POST /payouts/admin/lines/<lineId>/settle
```

Drive lists every transfer of the line's run (`transfer_group = runId`) from Stripe and looks for
the one whose metadata `payoutLineId` is this line:

| Stripe has | Result | Effect |
|---|---|---|
| exactly one transfer, same destination and amount | `200`, line `transferred` with that transfer id | The debit stands. |
| none, and the line has been unresolved for at least an hour | `200`, line `failed` (`settled.not-transferred`) | Debit reversed; the next run pays it again. |
| none, within the first hour | `409 payouts.settle-too-early` | Nothing changes. Try again later. |
| none with this line's id, but one without a line id to the same account for the same amount | `409 payouts.settle-ambiguous` | Nothing changes. Escalate (step 4). |
| one with another destination or amount | `409 payouts.settle-mismatch` | Nothing changes. Escalate (step 4). |
| more than one | `409 payouts.settle-ambiguous` | Nothing changes. Escalate (step 4). |
| Stripe unreachable, or a list it answered wrongly | `503 payouts.provider-unavailable` | Nothing changes. Retry later. |

A line that is no longer `unresolved` (settled by someone else, or a webhook arrived first)
answers `409 payouts.line-state` and changes nothing. Settling twice is therefore safe.

**Settling a fresh line.** Drive refuses to settle a line as "not transferred" within an hour
of the line's last change, so that a transfer Stripe is still processing has time to appear in
the list. Settling as transferred is allowed at once.

## 4. Escalate a mismatch or ambiguity

A mismatch or several transfers for one line means money left in a way Drive did not plan.
Treat it as a payments incident:

1. Do not settle again, and do not reverse anything in Stripe yet.
2. Note the line id, run id and courier id from step 1 (no bank or identity details).
3. Hand them to the CTO (Ali) and the security-tester (Hassan). They compare the Stripe
   dashboard's transfers for that `transfer_group` with the line.
4. A correction goes through a ledger adjustment, audited, with a reason:
   `POST /payouts/admin/couriers/<courierId>/adjustments`, with the body
   `{amount:{amount,currency}, reason, key}` (protected key `payouts.adjustment.record`). Never
   edit the database.

## 5. Reversals reported by Stripe

When Stripe reverses a transfer (`transfer.reversed`), the webhook marks the line `reversed`
and credits the courier back. If the webhook cannot match the reversal to a line of this
Market yet, it answers `503` so that Stripe redelivers, and logs the warning
`payouts.webhook-reversal-unmatched`. If that warning repeats for more than a day, escalate it as
in step 4. `payouts.webhook-reversal-foreign` (a transfer without Drive's metadata) and
`payouts.webhook-reversal-currency-mismatch` are acknowledged without changing anything, and are
always escalated.
