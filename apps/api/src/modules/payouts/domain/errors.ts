/** A rule of the payouts domain was broken. `code` is stable and is what API clients match on. */
export class PayoutsDomainError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'PayoutsDomainError';
  }
}
