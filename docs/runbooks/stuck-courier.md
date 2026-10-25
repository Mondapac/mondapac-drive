# A courier cannot go offline (open job after a lost delivery event)

**Symptom.** The courier app shows "you have an active delivery". `PUT /fleet/courier/me/shift`
`{state: offline}` answers 409 `fleet.shift.active-delivery`. The courier also drops out of
dispatch, which skips couriers who have an open job.

**Cause.** Fleet keeps a `fleet.courier_jobs` row per delivery and ends it when delivery's
terminal event (`delivery.status-changed.v1` to delivered or failed, or
`delivery.cancelled.v1`) reaches the subscribers `fleet.follow-delivery-status` or
`fleet.follow-delivery-cancelled`. If that event delivery was dead-lettered (10 failed claims),
the job never ends (package 31, Hassan L2 on #40).

## Alert

Two signals, both set up at go-live ([go-live.md](go-live.md)):

1. The worker's error line `event-delivery.dead` (`alert: true`) with a subscriber starting with
   `fleet.`.
2. A job open too long. Run this every 15 minutes with a read-only monitoring role, and alert on
   any row:

   ```sql
   SELECT market_id, delivery_id, assigned_at
     FROM fleet.courier_jobs
    WHERE NOT ended AND assigned_at < now() - interval '12 hours';
   ```

   The query reads ids and a time only, no personal data. 12 hours is longer than any
   same-day delivery. Tighten it once the pilot shows real durations.

## Fix

1. **Find the delivery.** The alert gives the `delivery_id`. Open it in the panel (Deliveries),
   or call `GET /delivery/admin/deliveries/:id`, and read its status.
2. **If the delivery really is finished** (delivered, failed or cancelled), the event was lost.
   Re-drive it. As the migration role, in a transaction, after checking the row:

   ```sql
   SELECT event_id, subscriber, type, attempts, error_code
     FROM platform.event_delivery
    WHERE status = 'dead' AND subscriber LIKE 'fleet.%' AND market_id = '<market>'
      AND aggregate_id = '<delivery_id>';

   -- Has the handler already run this event? A row here means yes.
   SELECT 1 FROM fleet.inbox WHERE event_id = '<event_id>' AND handler = '<subscriber>';

   UPDATE platform.event_delivery
      SET status = 'pending', attempts = 0, next_attempt_at = now(), dead_at = NULL
    WHERE status = 'dead' AND market_id = '<market>'
      AND event_id = '<event_id>' AND subscriber = '<subscriber>';
   ```

   If the inbox check finds a row, the handler already ran: set `status = 'delivered'` instead
   of `'pending'` and look elsewhere for why the job is open (escalate to Hossein). Otherwise the
   dispatcher hands the event out again within a second, and the inbox row it writes keeps any
   later re-drive from running twice. The inbox retention job (`platform.inbox-retention`) never
   purges the inbox row of a dead delivery, so the check stays reliable however old the event
   is. If it dies again, read its `error_code` and escalate to Hossein. Do not delete the job
   row by hand.
3. **If the delivery is still open** (the courier abandoned it, or the app lost it), a dispatcher
   unassigns the courier or reassigns the delivery: Deliveries → the delivery → Unassign, or
   `POST /delivery/admin/deliveries/:id/dispatch {type: courier_unassigned}`. The unassignment
   event ends the fleet job, and dispatch offers the delivery again.
4. **Check.** `GET /fleet/admin/couriers/:id` shows `activeDeliveryId: null`, and the courier can
   go offline.

Re-driving by SQL as the migration role is a stop-gap. Follow-up (Hassan, #49): an operator
command for re-drives, or a narrow role that may only update `platform.event_delivery`. Every
re-drive is noted in the incident log with the Market and the event id.
