import { err, ok } from '@mondapac-drive/shared-kernel';
import type { CallContext, Id, Result, Temporal } from '@mondapac-drive/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { MERCHANT_API_KEY_ISSUE, MERCHANT_VIEW } from '../../contracts/permissions';
import { ApiKeyIssuedAudit, ApiKeyRevokedAudit } from '../../domain/audit';
import { hasForbiddenFormatting } from '../../domain/merchant';
import { API_KEY_LABEL_MAX, openSession } from '../../domain/session';
import { isWellFormedText } from '../../domain/well-formed-text';
import {
  asActingAdmin,
  type MerchantAdminDependencies,
  type MerchantAdminRefusal,
} from '../merchants/merchant-admin';
import type { FieldProblem } from '../field-problem';

export interface IssueMerchantApiKeyInput {
  readonly merchantId: Id<'Merchant'>;
  /** What the operator calls the key ("marketplace production"). Not a secret; never logged. */
  readonly label: string;
}

export interface IssueMerchantApiKeyOutput {
  readonly code: 'api-key.issued';
  readonly keyId: Id<'Session'>;
  /** The key itself: answered once, never stored, logged or audited (only its hash is stored). */
  readonly key: string;
  readonly expiresAt: Temporal.Instant;
}

export type IssueMerchantApiKeyFailure =
  | { readonly code: 'validation.failed'; readonly fields: readonly FieldProblem[] }
  | { readonly code: 'merchant.unknown' }
  | { readonly code: 'merchant.suspended' }
  | MerchantAdminRefusal;

/**
 * Issues an API key to a merchant (Drive): the credential the marketplace's carrier integration
 * sends as `Authorization: Bearer`. Rule `permissions [identity.merchant-api-key.issue]`
 * (protected: a key acts for the merchant). A key is a session of the merchant's integration
 * account with transport `api-key`, scoped to this Market and this merchant, its lifetime the
 * Market's `identity.apiKeys.lifetimeDays` (idle equal to absolute). In one unit, with the actor
 * read again: the merchant still `active`, its version stepped (so a suspension racing the issue
 * either revokes the key or makes the issue stale), the session stored with the SHA-256 of the
 * key. The key is answered once.
 */
export class IssueMerchantApiKey extends UseCase<
  IssueMerchantApiKeyInput,
  IssueMerchantApiKeyOutput,
  IssueMerchantApiKeyFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'identity.issue-merchant-api-key',
    rule: { kind: 'permissions', allOf: [MERCHANT_API_KEY_ISSUE.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: MerchantAdminDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: IssueMerchantApiKeyInput,
  ): Promise<Result<IssueMerchantApiKeyOutput, IssueMerchantApiKeyFailure>> {
    const label = typeof input.label === 'string' ? input.label.trim() : '';
    if (label.length < 1 || label.length > API_KEY_LABEL_MAX) {
      return err({ code: 'validation.failed', fields: [{ path: 'label', code: 'length' }] });
    }
    if (!isWellFormedText(label) || hasForbiddenFormatting(label)) {
      return err({ code: 'validation.failed', fields: [{ path: 'label', code: 'characters' }] });
    }
    const { market } = context;
    const lifetime = this.deps.policy.apiKeyLifetime(market);
    if (lifetime === null) return err({ code: 'access.unavailable' });
    return asActingAdmin(
      this.deps,
      context,
      'identity.issue-merchant-api-key',
      [MERCHANT_API_KEY_ISSUE.key],
      async (): Promise<Result<IssueMerchantApiKeyOutput, IssueMerchantApiKeyFailure>> => {
        const now = this.deps.clock.now();
        const merchant = await this.deps.merchants.findById(market, input.merchantId);
        if (merchant === null) return err({ code: 'merchant.unknown' });
        if (!merchant.isActive) return err({ code: 'merchant.suspended' });
        const [accountId] = await this.deps.memberships.activeMembersOf(market, input.merchantId);
        if (accountId === undefined) return err({ code: 'access.unavailable' });
        merchant.touch();
        await this.deps.merchants.save(market, merchant);
        const issued = this.deps.sessionTokens.issue('api-key');
        const session = openSession({
          id: this.deps.ids.next<'Session'>(),
          marketId: market.marketId,
          accountId,
          population: 'merchant',
          merchantId: input.merchantId,
          transport: 'api-key',
          label,
          lifetime,
          now,
        });
        await this.deps.sessions.add(market, session, issued.tokenHash);
        await this.deps.audit.record(
          context,
          ApiKeyIssuedAudit.entry(session.id, {
            after: { merchantId: input.merchantId, accountId },
          }),
        );
        return ok({
          code: 'api-key.issued',
          keyId: session.id,
          key: issued.token,
          expiresAt: session.absoluteExpiresAt,
        });
      },
      (value) => ({ merchantId: input.merchantId, keyId: value.keyId }),
    );
  }
}

export interface RevokeMerchantApiKeyInput {
  readonly merchantId: Id<'Merchant'>;
  readonly keyId: Id<'Session'>;
}

export interface RevokeMerchantApiKeyOutput {
  readonly code: 'api-key.revoked';
  readonly keyId: Id<'Session'>;
}

export type RevokeMerchantApiKeyFailure =
  { readonly code: 'api-key.unknown' } | MerchantAdminRefusal;

/**
 * Revokes one API key of a merchant (Drive). Rule `permissions [identity.merchant-api-key.issue]`.
 * The key must be an API key of this merchant in this Market, not revoked yet; anything else is
 * `api-key.unknown` (one answer, so a key id of another merchant tells nothing).
 */
export class RevokeMerchantApiKey extends UseCase<
  RevokeMerchantApiKeyInput,
  RevokeMerchantApiKeyOutput,
  RevokeMerchantApiKeyFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'identity.revoke-merchant-api-key',
    rule: { kind: 'permissions', allOf: [MERCHANT_API_KEY_ISSUE.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: MerchantAdminDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: RevokeMerchantApiKeyInput,
  ): Promise<Result<RevokeMerchantApiKeyOutput, RevokeMerchantApiKeyFailure>> {
    const { market } = context;
    return asActingAdmin(
      this.deps,
      context,
      'identity.revoke-merchant-api-key',
      [MERCHANT_API_KEY_ISSUE.key],
      async (): Promise<Result<RevokeMerchantApiKeyOutput, RevokeMerchantApiKeyFailure>> => {
        const now = this.deps.clock.now();
        const key = await this.deps.sessions.findById(market, input.keyId);
        if (
          key === null ||
          key.transport !== 'api-key' ||
          key.merchantId !== input.merchantId ||
          key.revokedAt !== null
        ) {
          return err({ code: 'api-key.unknown' });
        }
        const revoked = await this.deps.sessions.revoke(
          market,
          key.id,
          key.accountId,
          'api-key-revoked',
          now,
        );
        if (!revoked) return err({ code: 'api-key.unknown' });
        await this.deps.audit.record(
          context,
          ApiKeyRevokedAudit.entry(key.id, { after: { merchantId: input.merchantId } }),
        );
        return ok({ code: 'api-key.revoked', keyId: key.id });
      },
      (value) => ({ merchantId: input.merchantId, keyId: value.keyId }),
    );
  }
}

export interface ListMerchantApiKeysInput {
  readonly merchantId: Id<'Merchant'>;
}

export interface ApiKeyRow {
  readonly keyId: Id<'Session'>;
  readonly label: string;
  readonly createdAt: Temporal.Instant;
  readonly lastSeenAt: Temporal.Instant;
  readonly expiresAt: Temporal.Instant;
}

export interface ListMerchantApiKeysOutput {
  readonly items: readonly ApiKeyRow[];
}

export type ListMerchantApiKeysFailure =
  { readonly code: 'merchant.unknown' } | MerchantAdminRefusal;

/**
 * The live API keys of a merchant, newest first (Drive). Rule `permissions
 * [identity.merchant.view]`. Never a key or its hash: the label, when it was issued, last used
 * (to the minute) and when it expires.
 */
export class ListMerchantApiKeys extends UseCase<
  ListMerchantApiKeysInput,
  ListMerchantApiKeysOutput,
  ListMerchantApiKeysFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'identity.list-merchant-api-keys',
    rule: { kind: 'permissions', allOf: [MERCHANT_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: MerchantAdminDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: ListMerchantApiKeysInput,
  ): Promise<Result<ListMerchantApiKeysOutput, ListMerchantApiKeysFailure>> {
    const { market } = context;
    return asActingAdmin(
      this.deps,
      context,
      'identity.list-merchant-api-keys',
      [MERCHANT_VIEW.key],
      async (): Promise<Result<ListMerchantApiKeysOutput, ListMerchantApiKeysFailure>> => {
        const merchant = await this.deps.merchants.findById(market, input.merchantId);
        if (merchant === null) return err({ code: 'merchant.unknown' });
        const keys = await this.deps.sessions.listApiKeysOf(
          market,
          input.merchantId,
          this.deps.clock.now(),
        );
        return ok({
          items: keys.map((key) => ({
            keyId: key.id,
            label: key.label ?? '',
            createdAt: key.createdAt,
            lastSeenAt: key.lastSeenAt,
            expiresAt: key.absoluteExpiresAt,
          })),
        });
      },
      (value) => ({ merchantId: input.merchantId, keys: String(value.items.length) }),
    );
  }
}
