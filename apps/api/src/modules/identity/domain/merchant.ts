import { err, ok } from '@mondapac-drive/shared-kernel';
import type { Id, MarketId, Result, Temporal } from '@mondapac-drive/shared-kernel';
import { isWellFormedText } from './well-formed-text';

/** A merchant is active or suspended; a suspended merchant's keys stop working. */
export const MERCHANT_STATES = ['active', 'suspended'] as const;
export type MerchantStateCode = (typeof MERCHANT_STATES)[number];

/** Why a merchant name was refused. */
export type MerchantNameInvalid = {
  readonly code: 'merchant-name.invalid';
  readonly rule: 'length' | 'characters';
};

const MAX_NAME_LENGTH = 100;
/** C0 and C1 controls and the bidi marks: the class of `merchants_name_check`. */
const FORBIDDEN = /[\p{Cc}؜‎‏‪-‮⁦-⁩]/u;

/**
 * Whether text an operator typed for a merchant (its name, an API key's label) holds a control
 * or bidi formatting character, which could make the admin panel show it as something else.
 */
export function hasForbiddenFormatting(text: string): boolean {
  return FORBIDDEN.test(text);
}

/**
 * A merchant's business name, as an operator typed it: trimmed, 1 to 100 code points, no control
 * or bidi formatting character. Unlike a person's display name it may look like a host name
 * ("Halal.com.au"): it is the business, not a person.
 */
export function parseMerchantName(raw: unknown): Result<string, MerchantNameInvalid> {
  if (typeof raw !== 'string') return err({ code: 'merchant-name.invalid', rule: 'length' });
  const name = raw.trim();
  const length = [...name].length;
  if (length < 1 || length > MAX_NAME_LENGTH) {
    return err({ code: 'merchant-name.invalid', rule: 'length' });
  }
  if (FORBIDDEN.test(name) || !isWellFormedText(name)) {
    return err({ code: 'merchant-name.invalid', rule: 'characters' });
  }
  return ok(name);
}

/** The state of a {@link Merchant}. */
export interface MerchantState {
  readonly id: Id<'Merchant'>;
  readonly marketId: MarketId;
  readonly name: string;
  readonly state: MerchantStateCode;
  readonly stateChangedAt: Temporal.Instant;
  readonly version: number;
  readonly createdAt: Temporal.Instant;
}

/** A state that breaks an invariant: a bug of the caller or a corrupt row. */
export class MerchantInvariantError extends Error {
  override readonly name = 'MerchantInvariantError';
  constructor(readonly invariant: 'state' | 'version' | 'name') {
    super(`Merchant invariant broken: ${invariant}`);
  }
}

/** The state change was refused: the merchant is already in that state. */
export type MerchantStateRefused =
  { readonly code: 'merchant.already-suspended' } | { readonly code: 'merchant.already-active' };

/**
 * The `Merchant` aggregate (Drive; the marketplace's `SellerAccess`, reduced to what Drive
 * needs): a business that books deliveries in one Market. An operator creates it, active; its
 * integration account and that account's API keys act for it. Suspending it revokes every key in
 * the same unit (the use case's part); reinstating it issues none again.
 */
export class Merchant {
  #state: MerchantState;

  private constructor(
    state: MerchantState,
    /** The version read from the store; null for a merchant not stored yet. */
    readonly persistedVersion: number | null,
  ) {
    if (!(MERCHANT_STATES as readonly string[]).includes(state.state)) {
      throw new MerchantInvariantError('state');
    }
    if (!Number.isInteger(state.version) || state.version < 1) {
      throw new MerchantInvariantError('version');
    }
    if (!parseMerchantName(state.name).ok) throw new MerchantInvariantError('name');
    this.#state = Object.freeze({ ...state });
  }

  /** A new, active merchant with the name the caller parsed ({@link parseMerchantName}). */
  static create(input: {
    readonly id: Id<'Merchant'>;
    readonly marketId: MarketId;
    readonly name: string;
    readonly now: Temporal.Instant;
  }): Merchant {
    const { id, marketId, name, now } = input;
    return new Merchant(
      {
        id,
        marketId,
        name,
        state: 'active',
        stateChangedAt: now,
        version: 1,
        createdAt: now,
      },
      null,
    );
  }

  /** A merchant read from the store. Checks the invariants again. */
  static restore(state: MerchantState): Merchant {
    return new Merchant(state, state.version);
  }

  get state(): MerchantState {
    return this.#state;
  }

  /** Whether its keys may authenticate. */
  get isActive(): boolean {
    return this.#state.state === 'active';
  }

  /** `active` → `suspended`. */
  suspend(now: Temporal.Instant): Result<void, MerchantStateRefused> {
    if (this.#state.state === 'suspended') return err({ code: 'merchant.already-suspended' });
    this.change('suspended', now);
    return ok(undefined);
  }

  /** `suspended` → `active`. */
  reinstate(now: Temporal.Instant): Result<void, MerchantStateRefused> {
    if (this.#state.state === 'active') return err({ code: 'merchant.already-active' });
    this.change('active', now);
    return ok(undefined);
  }

  /**
   * A version step with nothing else changed: issuing or revoking a key takes it, so two
   * operators acting on one merchant's keys at once serialise on the merchant.
   */
  touch(): void {
    this.#state = Object.freeze({ ...this.#state, version: this.#state.version + 1 });
  }

  private change(state: MerchantStateCode, now: Temporal.Instant): void {
    this.#state = Object.freeze({
      ...this.#state,
      state,
      stateChangedAt: now,
      version: this.#state.version + 1,
    });
  }
}

/** The membership states of an account in its merchant. */
export const MERCHANT_MEMBERSHIP_STATES = ['active', 'removed'] as const;
export type MerchantMembershipStateCode = (typeof MERCHANT_MEMBERSHIP_STATES)[number];

/**
 * Which merchant a merchant-population account acts for (the marketplace's `SellerMembership`).
 * Today only the integration account holds one, founded with the merchant; one active
 * membership per account is a database rule.
 */
export interface MerchantMembership {
  readonly id: Id<'MerchantMembership'>;
  readonly marketId: MarketId;
  readonly accountId: Id<'Account'>;
  readonly merchantId: Id<'Merchant'>;
  readonly state: MerchantMembershipStateCode;
  readonly removedAt: Temporal.Instant | null;
  readonly version: number;
  readonly createdAt: Temporal.Instant;
}

/** The founding membership of a merchant's integration account. */
export function foundMerchantMembership(input: {
  readonly id: Id<'MerchantMembership'>;
  readonly marketId: MarketId;
  readonly accountId: Id<'Account'>;
  readonly merchantId: Id<'Merchant'>;
  readonly now: Temporal.Instant;
}): MerchantMembership {
  return Object.freeze({
    id: input.id,
    marketId: input.marketId,
    accountId: input.accountId,
    merchantId: input.merchantId,
    state: 'active',
    removedAt: null,
    version: 1,
    createdAt: input.now,
  });
}
