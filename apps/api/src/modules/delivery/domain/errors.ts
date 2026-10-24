/** A rule of the delivery domain was broken. `code` is stable and is what API clients match on. */
export class DeliveryDomainError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'DeliveryDomainError';
  }
}
