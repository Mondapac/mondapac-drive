import type {
  CallContext,
  Id,
  MarketContext,
  MarketId,
  Money,
  Result,
  Temporal,
} from '@mondapac-drive/shared-kernel';
import type { CompletedDelivery, EarningBreakdown } from '../domain/earnings';
import type { Balance, LedgerEntry } from '../domain/ledger';
import type { Engagement, Payee } from '../domain/payee';
import type {
  CourierBalance,
  PayoutAccount,
  PayoutLine,
  PayoutLineStatus,
  PayoutRun,
} from '../domain/payout-run';
import type { MarketPayoutSettings, Temperature, VehicleType } from '../domain/payout-settings';

/** A completed delivery as payouts records it, for every courier, employees included. */
export interface CourierDeliveryRecord {
  readonly delivery: CompletedDelivery;
  readonly engagement: Engagement;
  readonly earning: EarningBreakdown;
  readonly recordedAt: Temporal.Instant;
}

/**
 * The append-only ledger and the delivery records of one Market. Every method runs inside the
 * caller's unit of work; writes in a read-write unit. Nothing here updates or deletes.
 */
export interface LedgerRepository {
  /** Appends `entries`; one whose reference is already taken is skipped. Answers how many were new. */
  append(market: MarketContext, entries: readonly LedgerEntry[]): Promise<number>;
  findByReference(market: MarketContext, reference: string): Promise<LedgerEntry | undefined>;
  /** Every entry of one delivery, oldest first. */
  entriesOfDelivery(market: MarketContext, deliveryId: string): Promise<LedgerEntry[]>;
  /** The latest entries of one courier, newest first. */
  recentEntries(market: MarketContext, courierId: string, limit: number): Promise<LedgerEntry[]>;
  /** One courier's balance over every entry. */
  balanceOf(market: MarketContext, courierId: string, currency: string): Promise<Balance>;
  /** Every courier's balance over the entries that occurred before `cutoff`. */
  balancesBefore(
    market: MarketContext,
    cutoff: Temporal.Instant,
    currency: string,
  ): Promise<CourierBalance[]>;
  /** Records a delivery once; false, and nothing written, when it was already recorded. */
  recordDelivery(market: MarketContext, record: CourierDeliveryRecord): Promise<boolean>;
  /**
   * What one courier earned since `since`: every credit and debit (earnings, tips, adjustments
   * and reversals) that occurred at or after it, tax included; payouts are not counted.
   */
  earnedSince(
    market: MarketContext,
    courierId: string,
    since: Temporal.Instant,
    currency: string,
  ): Promise<Money>;
  /** How many deliveries one courier delivered at or after `since`. */
  deliveriesSince(market: MarketContext, courierId: string, since: Temporal.Instant): Promise<number>;
}
export const LEDGER_REPOSITORY = Symbol('LedgerRepository');

/** Payout runs and their lines. */
export interface PayoutRunRepository {
  findRunByCutoff(market: MarketContext, cutoff: Temporal.Instant): Promise<PayoutRun | undefined>;
  /** Inserts a run and its lines; false, and nothing written, when the cutoff already has a run. */
  insertRun(market: MarketContext, run: PayoutRun, lines: readonly PayoutLine[]): Promise<boolean>;
  /** Up to `limit` pending lines, oldest first. */
  pendingLines(market: MarketContext, limit: number): Promise<PayoutLine[]>;
  findLine(market: MarketContext, id: Id<'PayoutLine'>): Promise<PayoutLine | undefined>;
  findLineByTransfer(market: MarketContext, transferId: string): Promise<PayoutLine | undefined>;
  /**
   * Up to `limit` lines in one of `statuses`, oldest first, after the line `after` (a cursor
   * from the previous page).
   */
  listLines(market: MarketContext, query: LineQuery): Promise<PayoutLine[]>;
  /** Saves version n + 1 over n; throws `StaleAggregateError` when the stored version moved. */
  updateLine(market: MarketContext, line: PayoutLine): Promise<void>;
}
export const PAYOUT_RUN_REPOSITORY = Symbol('PayoutRunRepository');

export interface LineQuery {
  readonly statuses: readonly PayoutLineStatus[];
  readonly courierId?: string;
  readonly limit: number;
  readonly after?: Id<'PayoutLine'>;
}

/** The couriers' connected accounts and the provider events already handled. */
export interface PayoutAccountRepository {
  find(market: MarketContext, courierId: string): Promise<PayoutAccount | undefined>;
  findMany(market: MarketContext, courierIds: readonly string[]): Promise<PayoutAccount[]>;
  findByProviderAccount(
    market: MarketContext,
    providerAccountId: string,
  ): Promise<PayoutAccount | undefined>;
  /** False, and nothing written, when the courier already has an account. */
  insert(market: MarketContext, account: PayoutAccount): Promise<boolean>;
  /** Saves `payoutsEnabled`, `providerStateAt` and `updatedAt`. */
  update(market: MarketContext, account: PayoutAccount): Promise<void>;
  /** Records a provider event id once; false when it was already recorded. */
  recordProviderEvent(
    market: MarketContext,
    eventId: string,
    type: string,
    receivedAt: Temporal.Instant,
  ): Promise<boolean>;
}
export const PAYOUT_ACCOUNT_REPOSITORY = Symbol('PayoutAccountRepository');

/**
 * The couriers payouts pays, as the fleet module knows them, by courier id (the courier's
 * identity account id). Called outside any unit of work, with the caller's context.
 */
export interface PayeeDirectory {
  /** The payees among `courierIds`; an id fleet does not know is left out. */
  payees(context: CallContext, courierIds: readonly string[]): Promise<ReadonlyMap<string, Payee>>;
}
export const PAYEE_DIRECTORY = Symbol('PayeeDirectory');

/** What payouts reads of a delivered delivery to price it, from the delivery module. */
export interface DeliveryFacts {
  readonly vehicle: VehicleType;
  readonly distanceMetres: number;
  readonly temperature: Temperature;
}

/** The delivery module's facts about a delivery. Called outside any unit of work. */
export interface DeliveryFactsReader {
  /** The facts of a delivery of the context's Market, or `undefined` when it is unknown. */
  factsOf(context: CallContext, deliveryId: string): Promise<DeliveryFacts | undefined>;
}
export const DELIVERY_FACTS = Symbol('DeliveryFactsReader');

/** The payout settings of the Markets this deployment hosts. */
export interface PayoutSettingsProvider {
  get(marketId: MarketId): MarketPayoutSettings;
}
export const PAYOUT_SETTINGS = Symbol('PayoutSettingsProvider');

/** Why the provider refused a call. Transient refusals (network, rate limit, 5xx) may be retried. */
export interface GatewayRefusal {
  readonly code: string;
  readonly transient: boolean;
}

/**
 * The payment provider that holds the couriers' connected accounts and moves money to them
 * (Stripe Connect, Express accounts). Calls are made outside any unit of work. Every call that
 * creates something carries an idempotency key, so a retry never creates it twice.
 */
export interface PayoutGateway {
  /**
   * False when this deployment has no provider credentials: then nothing is sent, pending lines
   * stay pending and onboarding is refused.
   */
  readonly enabled: boolean;
  /** Creates a connected account; the key makes a retry answer the same account. */
  createAccount(request: {
    readonly country: string;
    readonly idempotencyKey: string;
    readonly metadata: Readonly<Record<string, string>>;
  }): Promise<Result<{ readonly accountId: string }, GatewayRefusal>>;
  /** A short-lived link to the provider's hosted onboarding of an account. */
  createOnboardingLink(request: {
    readonly accountId: string;
    readonly returnUrl: string;
    readonly refreshUrl: string;
  }): Promise<
    Result<{ readonly url: string; readonly expiresAt: Temporal.Instant }, GatewayRefusal>
  >;
  /** Moves `amount` from the platform's balance to the connected account `destination`. */
  createTransfer(request: {
    readonly amount: Money;
    readonly destination: string;
    readonly idempotencyKey: string;
    readonly metadata: Readonly<Record<string, string>>;
  }): Promise<Result<{ readonly transferId: string }, GatewayRefusal>>;
  /**
   * Every transfer the provider holds in one transfer group (a payout run's id), for settling
   * an unresolved line. A refusal, or more transfers than one lookup reads, is an `err`.
   */
  transfersOfGroup(group: string): Promise<Result<readonly ProviderTransfer[], GatewayRefusal>>;
}

/** A transfer as the provider holds it: what settling an unresolved line compares. */
export interface ProviderTransfer {
  readonly transferId: string;
  readonly amount: Money;
  readonly destination: string;
  /** `metadata.payoutLineId`, when the transfer carries one. */
  readonly payoutLineId?: string;
}
export const PAYOUT_GATEWAY = Symbol('PayoutGateway');

/** A provider webhook event, verified and reduced to what payouts acts on. */
export type ProviderEvent =
  | {
      readonly kind: 'account-updated';
      readonly id: string;
      readonly type: string;
      readonly accountId: string;
      readonly payoutsEnabled: boolean;
      /** When the provider produced the event (`created`): reports arrive in no order. */
      readonly created: Temporal.Instant;
    }
  | {
      readonly kind: 'transfer-reversed';
      readonly id: string;
      readonly type: string;
      readonly transferId: string;
      /** The running total taken back, in minor units of `currency`. */
      readonly amountReversed: bigint;
      readonly currency: string;
      /** The transfer's `metadata.marketId` and `metadata.payoutLineId`, when Drive sent it. */
      readonly marketId?: string;
      readonly payoutLineId?: string;
    }
  | { readonly kind: 'ignored'; readonly id: string; readonly type: string };

export type WebhookRefusal = 'signature-invalid' | 'payload-invalid';

/**
 * Verifies a provider webhook: the signature over the exact bytes received, made with one of
 * the configured secrets, within the replay tolerance of `now`, and parses the event.
 */
export interface ProviderWebhookVerifier {
  verify(
    rawBody: Buffer,
    signatureHeader: string | undefined,
    now: Temporal.Instant,
  ): Result<ProviderEvent, WebhookRefusal>;
}
export const PROVIDER_WEBHOOK_VERIFIER = Symbol('ProviderWebhookVerifier');
