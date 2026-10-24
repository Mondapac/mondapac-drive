/** A rule of the fleet domain was broken. `code` is stable and is what API clients match on. */
export class FleetDomainError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'FleetDomainError';
  }
}
