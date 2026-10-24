import type { RecipientDirectory, TrackingLinks } from '../application/ports';

/**
 * Stand-ins until the delivery module exposes the recipient's number (after WP2) and tracking
 * (package 06) issues links through its public interface. With them an SMS that needs either
 * is dead-lettered (no number) or retried until it dies (no link); webhooks are unaffected.
 */
export class NoRecipientDirectory implements RecipientDirectory {
  phoneOf(): Promise<string | undefined> {
    return Promise.resolve(undefined);
  }
}

export class NoTrackingLinks implements TrackingLinks {
  linkFor(): Promise<string | undefined> {
    return Promise.resolve(undefined);
  }
}
