import type { MarketContext, Population, Temporal } from '@mondapac-drive/shared-kernel';

/**
 * The mails of `identity` (identity design 9): to admins and couriers only; a merchant's
 * integration account is never mailed. What varies is data; the words come from the module's
 * locale files, in the Market's default locale.
 */
export type IdentityMail =
  | {
      /** E8: the reset link (slice 4). */
      readonly template: 'reset-password';
      readonly population: Population;
      /** The reset page, with the token in the fragment. */
      readonly url: string;
      readonly lifetimeMinutes: number;
    }
  | {
      /**
       * E13: the password was changed or reset (slice 4). A notice without a button (`ux.md`
       * 3.4): what changed, when, and "if this wasn't you".
       */
      readonly template: 'password-changed';
      readonly population: Population;
      /** When the password was changed: written in the Market's time zone and locale. */
      readonly changedAt: Temporal.Instant;
    }
  | {
      /**
       * The holder signed out every other session of the account (profile package 4, Hassan's
       * follow-up). A notice without a button: when, and "if this wasn't you".
       */
      readonly template: 'other-sessions-signed-out';
      readonly population: 'admin' | 'courier';
      /** When they were signed out: written in the Market's time zone and locale. */
      readonly changedAt: Temporal.Instant;
    }
  | {
      /** The enrolment link of 3.6 (HF6; slice 7b): start a second factor again. */
      readonly template: 'enrol-second-factor';
      readonly population: Population;
      /** The enrolment page, with the token in the fragment. */
      readonly url: string;
      readonly lifetimeMinutes: number;
    }
  | {
      /** An invitation (identity design 3.4): an admin's or a courier's. No inviter's name. */
      readonly template: 'invitation';
      readonly population: 'admin' | 'courier';
      /** The acceptance page, with the token in the fragment. */
      readonly url: string;
      readonly lifetimeMinutes: number;
    }
  | {
      /**
       * A notice that the second factor changed (identity design 3.6, 6.8; slice 7b item C):
       * replaced, reset, or locked after too many wrong codes (HF2). No button; "not you?".
       */
      readonly template: 'second-factor-changed';
      readonly population: Population;
      readonly change: 'replaced' | 'reset' | 'locked';
      /** When it changed: written in the Market's time zone and locale. */
      readonly changedAt: Temporal.Instant;
    };

/** A rendered mail: plain text only (identity design 9; HF13). */
export interface ComposedMail {
  readonly subject: string;
  readonly text: string;
}

/**
 * Renders a mail of `identity` (identity design 9, translation keys `identity.mail.<template>`):
 * named placeholders, no ICU, the lifetime as a duration so no zone is needed (ADR-0005
 * decision 3). Throws when the Market's locale has no catalogue, which the module checks at boot.
 */
export interface IdentityMailComposer {
  compose(market: MarketContext, mail: IdentityMail): ComposedMail;
}

/** Nest token of the {@link IdentityMailComposer}. */
export const IDENTITY_MAIL_COMPOSER = Symbol('IDENTITY_MAIL_COMPOSER');
