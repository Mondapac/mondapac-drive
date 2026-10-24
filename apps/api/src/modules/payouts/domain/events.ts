import { defineEvent, eventField, type Id, type PendingEvent } from '@mondapac-drive/shared-kernel';
import type { PayoutLine } from './payout-run';

// The facts the payouts module publishes through its outbox, for the operations panel and
// notifications. Payloads hold ids and codes only: never an amount, a name or an account.

/** The provider accepted a payout line's transfer, from a payout run or an operator's settlement. */
export const payoutLineTransferred = defineEvent({
  type: 'payouts.line-transferred.v1',
  aggregateType: 'payout-line',
  payload: { lineId: eventField.id(), runId: eventField.id(), courierId: eventField.id() },
});

/**
 * A payout line will not be paid as planned: `failed` (refused for good, or settled as never
 * transferred; the balance waits for a later run) or `unresolved` (out of attempts on transient
 * refusals; an operator must settle it).
 */
export const payoutLineFailed = defineEvent({
  type: 'payouts.line-failed.v1',
  aggregateType: 'payout-line',
  payload: {
    lineId: eventField.id(),
    runId: eventField.id(),
    courierId: eventField.id(),
    status: eventField.enumOf(['failed', 'unresolved'] as const),
  },
});

export const PAYOUTS_EVENTS = [payoutLineTransferred, payoutLineFailed] as const;

/**
 * The event a line's change publishes, by its new status: a transfer, or a failure an operator
 * should see. Other changes (held, reversed, a retry still pending) publish nothing.
 */
export function eventsOfLine(line: PayoutLine): PendingEvent[] {
  const ids = { lineId: line.id, runId: line.runId, courierId: line.courierId as Id };
  const envelope = {
    aggregateId: line.id,
    aggregateVersion: line.version,
    occurredAt: line.updatedAt,
  };
  if (line.status === 'transferred') {
    return [payoutLineTransferred.record({ ...envelope, payload: ids })];
  }
  if (line.status === 'failed' || line.status === 'unresolved') {
    return [payoutLineFailed.record({ ...envelope, payload: { ...ids, status: line.status } })];
  }
  return [];
}
