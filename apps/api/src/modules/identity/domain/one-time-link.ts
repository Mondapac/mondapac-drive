import { err, ok, Temporal } from '@mondapac-drive/shared-kernel';
import type { Id, MarketId, PendingEvent, Result } from '@mondapac-drive/shared-kernel';
import { LINK_PURPOSES, OneTimeLinkRequested } from './events';

export type LinkPurpose = (typeof LINK_PURPOSES)[number];
export { LINK_PURPOSES };

/** Where a link stands at an instant (identity design 3.7). */
export type LinkStatus = 'requested' | 'issued' | 'consumed' | 'expired';

/** The state of a {@link OneTimeLink} (identity design 2.1, 3.7; data design 3.7). */
export interface OneTimeLinkState {
  readonly id: Id<'OneTimeLink'>;
  readonly marketId: MarketId;
  readonly accountId: Id<'Account'>;
  readonly purpose: LinkPurpose;
  /** The latest request. */
  readonly requestedAt: Temporal.Instant;
  /** SHA-256 of the token; null while `requested`. The token itself is never held. */
  readonly tokenHash: Uint8Array | null;
  readonly issuedAt: Temporal.Instant | null;
  readonly expiresAt: Temporal.Instant | null;
  readonly consumedAt: Temporal.Instant | null;
  readonly version: number;
}

/** A link that cannot be used now: one answer for every cause (identity design 8.6 row 1). */
export type LinkRejected = { readonly code: 'link.rejected' };
const REJECTED: LinkRejected = Object.freeze({ code: 'link.rejected' });

/**
 * The `OneTimeLink` aggregate (identity design 2.1 and 3.7): bound to one account, one purpose
 * and one Market; one row per account and purpose (M8), so a new request reuses it and the
 * earlier token stops working; single use; an expiry counted from the issue.
 *
 * - `request` / `requestAgain`: `requested`, no token. `notify` says whether the mail may go
 *   (the request's verdict on the mail counters, identity design 6.8; Mojtaba item 3): only
 *   then is `identity.one-time-link-requested.v1` recorded, so the mail handler never decides.
 * - `issue`: the mail handler stores the hash of the token it sent, from `requested` only.
 * - `consume`: from `issued` before the expiry; the repository's conditional statement is what
 *   makes two concurrent uses impossible (data design 3.7).
 *
 * Times come from the caller's `Clock`; every change raises the version by one and records at
 * most one event (platform persistence 5.1).
 */
export class OneTimeLink {
  #state: OneTimeLinkState;
  #events: PendingEvent[] = [];

  private constructor(
    state: OneTimeLinkState,
    /** The version read from the store; null for a link not stored yet. */
    readonly persistedVersion: number | null,
  ) {
    this.#state = Object.freeze({ ...state });
  }

  static request(input: {
    readonly id: Id<'OneTimeLink'>;
    readonly marketId: MarketId;
    readonly accountId: Id<'Account'>;
    readonly purpose: LinkPurpose;
    readonly now: Temporal.Instant;
    readonly notify: boolean;
  }): OneTimeLink {
    const { id, marketId, accountId, purpose, now, notify } = input;
    const link = new OneTimeLink(
      {
        id,
        marketId,
        accountId,
        purpose,
        requestedAt: now,
        tokenHash: null,
        issuedAt: null,
        expiresAt: null,
        consumedAt: null,
        version: 1,
      },
      null,
    );
    if (notify) link.recordRequested(now);
    return link;
  }

  static restore(state: OneTimeLinkState): OneTimeLink {
    return new OneTimeLink(state, state.version);
  }

  get state(): OneTimeLinkState {
    return this.#state;
  }

  get pendingEvents(): readonly PendingEvent[] {
    return [...this.#events];
  }

  statusAt(now: Temporal.Instant): LinkStatus {
    const { tokenHash, expiresAt, consumedAt } = this.#state;
    if (consumedAt !== null) return 'consumed';
    if (tokenHash === null || expiresAt === null) return 'requested';
    return Temporal.Instant.compare(now, expiresAt) < 0 ? 'issued' : 'expired';
  }

  /**
   * A new request for the same account and purpose (identity design 3.2, 3.7): the token, the
   * instants and the consumption are cleared, so an earlier link stops working at once.
   */
  requestAgain(now: Temporal.Instant, notify: boolean): void {
    this.change({
      requestedAt: now,
      tokenHash: null,
      issuedAt: null,
      expiresAt: null,
      consumedAt: null,
    });
    if (notify) this.recordRequested(now);
  }

  /**
   * The mail with the token was sent; the hash is stored and the lifetime starts (3.7). Only a
   * `requested` link is issued: a link issued, consumed or requested again since is not.
   */
  issue(
    tokenHash: Uint8Array,
    now: Temporal.Instant,
    lifetimeMinutes: number,
  ): Result<void, LinkRejected> {
    if (this.statusAt(now) !== 'requested') return err(REJECTED);
    if (tokenHash.length !== 32 || !Number.isInteger(lifetimeMinutes) || lifetimeMinutes < 1) {
      throw new RangeError('issue: a 32-byte hash and a positive whole lifetime are required');
    }
    this.change({
      tokenHash: Uint8Array.from(tokenHash),
      issuedAt: now,
      expiresAt: now.add({ minutes: lifetimeMinutes }),
    });
    return ok(undefined);
  }

  /** Whether the link may be used for this purpose now: issued, unused and not expired. */
  usableFor(purpose: LinkPurpose, now: Temporal.Instant): boolean {
    return this.#state.purpose === purpose && this.statusAt(now) === 'issued';
  }

  /** The single use (3.7). The repository's conditional update is the guarantee. */
  consume(now: Temporal.Instant): Result<void, LinkRejected> {
    if (this.statusAt(now) !== 'issued') return err(REJECTED);
    this.change({ consumedAt: now });
    return ok(undefined);
  }

  private change(fields: Partial<OneTimeLinkState>): void {
    this.#state = Object.freeze({ ...this.#state, ...fields, version: this.#state.version + 1 });
  }

  private recordRequested(now: Temporal.Instant): void {
    const { id, accountId, purpose, version } = this.#state;
    this.#events.push(
      OneTimeLinkRequested.record({
        aggregateId: id,
        aggregateVersion: version,
        occurredAt: now,
        payload: { linkId: id, accountId, purpose },
      }),
    );
  }
}
