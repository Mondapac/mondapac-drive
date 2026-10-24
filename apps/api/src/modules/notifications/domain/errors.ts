/** A rule of the notifications domain was broken. `code` is stable; the message holds no personal data. */
export class NotificationsDomainError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'NotificationsDomainError';
  }
}
