// The reason codes of the delivery events: who cancelled, or why a status changed.

/** Why a delivery was cancelled. */
export const CANCEL_REASON_CODES = ['merchant-cancelled', 'operator-cancelled'] as const;
export type CancelReasonCode = (typeof CANCEL_REASON_CODES)[number];

/** Why a status changed, when the change has a cause worth telling apart. */
export const STATUS_REASON_CODES = [
  'dispatcher-unassigned',
  'courier-reassigned',
  'delivery-failed',
] as const;
export type StatusReasonCode = (typeof STATUS_REASON_CODES)[number];

export type DeliveryReasonCode = CancelReasonCode | StatusReasonCode;
