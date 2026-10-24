import { err, ok } from '@mondapac-drive/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac-drive/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { MERCHANT_SUSPEND } from '../../contracts/permissions';
import { MerchantReinstatedAudit, MerchantSuspendedAudit } from '../../domain/audit';
import type { MerchantStateRefused } from '../../domain/merchant';
import {
  asActingAdmin,
  type MerchantAdminDependencies,
  type MerchantAdminRefusal,
} from '../merchants/merchant-admin';

export interface MerchantStateInput {
  readonly merchantId: Id<'Merchant'>;
}

export interface MerchantStateOutput {
  readonly code: 'merchant.suspended' | 'merchant.reinstated';
  readonly merchantId: Id<'Merchant'>;
}

export type MerchantStateFailure =
  { readonly code: 'merchant.unknown' } | MerchantStateRefused | MerchantAdminRefusal;

/**
 * Suspends a merchant (Drive). Rule `permissions [identity.merchant.suspend]` (protected). In one
 * unit, with the actor read again: the merchant `suspended` at the version read and every API key
 * of it revoked (`merchant-suspended`), so no key of a suspended merchant can book a delivery;
 * the authenticator also refuses a key whose merchant is not active. Audited with the count.
 */
export class SuspendMerchant extends UseCase<
  MerchantStateInput,
  MerchantStateOutput,
  MerchantStateFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'identity.suspend-merchant',
    rule: { kind: 'permissions', allOf: [MERCHANT_SUSPEND.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: MerchantAdminDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: MerchantStateInput,
  ): Promise<Result<MerchantStateOutput, MerchantStateFailure>> {
    const { market } = context;
    return asActingAdmin(
      this.deps,
      context,
      'identity.suspend-merchant',
      [MERCHANT_SUSPEND.key],
      async (): Promise<Result<MerchantStateOutput, MerchantStateFailure>> => {
        const now = this.deps.clock.now();
        const merchant = await this.deps.merchants.findById(market, input.merchantId);
        if (merchant === null) return err({ code: 'merchant.unknown' });
        const changed = merchant.suspend(now);
        if (!changed.ok) return err(changed.error);
        await this.deps.merchants.save(market, merchant);
        const revokedSessions = await this.deps.sessions.revokeAllOfMerchant(
          market,
          input.merchantId,
          'merchant-suspended',
          now,
        );
        await this.deps.audit.record(
          context,
          MerchantSuspendedAudit.entry(input.merchantId, {
            before: { state: 'active' },
            after: { state: 'suspended', revokedSessions },
          }),
        );
        return ok({ code: 'merchant.suspended', merchantId: input.merchantId });
      },
      (value) => ({ merchantId: value.merchantId }),
    );
  }
}

/**
 * Reinstates a suspended merchant (Drive). Rule `permissions [identity.merchant.suspend]`. Its
 * revoked keys stay revoked: an operator issues new ones.
 */
export class ReinstateMerchant extends UseCase<
  MerchantStateInput,
  MerchantStateOutput,
  MerchantStateFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'identity.reinstate-merchant',
    rule: { kind: 'permissions', allOf: [MERCHANT_SUSPEND.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: MerchantAdminDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: MerchantStateInput,
  ): Promise<Result<MerchantStateOutput, MerchantStateFailure>> {
    const { market } = context;
    return asActingAdmin(
      this.deps,
      context,
      'identity.reinstate-merchant',
      [MERCHANT_SUSPEND.key],
      async (): Promise<Result<MerchantStateOutput, MerchantStateFailure>> => {
        const merchant = await this.deps.merchants.findById(market, input.merchantId);
        if (merchant === null) return err({ code: 'merchant.unknown' });
        const changed = merchant.reinstate(this.deps.clock.now());
        if (!changed.ok) return err(changed.error);
        await this.deps.merchants.save(market, merchant);
        await this.deps.audit.record(
          context,
          MerchantReinstatedAudit.entry(input.merchantId, {
            before: { state: 'suspended' },
            after: { state: 'active' },
          }),
        );
        return ok({ code: 'merchant.reinstated', merchantId: input.merchantId });
      },
      (value) => ({ merchantId: value.merchantId }),
    );
  }
}
