/** A refusal of a tracking use case, mapped to an HTTP status by the entry points. */
export interface TrackingFailure {
  readonly code: string;
  readonly message: string;
  /** Only for `ping.throttled`. */
  readonly retryAfterSeconds?: number;
  /** Only for `ping.invalid`: the field, never its value. */
  readonly field?: string;
}

export const failure = (code: string, message: string, extra: Partial<TrackingFailure> = {}) =>
  Object.freeze({ code, message, ...extra }) as TrackingFailure;

export const deliveryNotTracked = () =>
  failure('tracking.delivery-not-found', 'The delivery is not tracked');
