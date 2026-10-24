/** A rule of the dispatch domain was broken. `code` is stable and is what callers match on. */
export class DispatchDomainError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'DispatchDomainError';
  }
}
