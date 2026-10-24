import { ok } from '@mondapac-drive/shared-kernel';
import type { CallContext, Id, Result, Temporal } from '@mondapac-drive/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { MERCHANT_VIEW } from '../../contracts/permissions';
import type { MerchantStateCode } from '../../domain/merchant';
import {
  asActingAdmin,
  type MerchantAdminDependencies,
  type MerchantAdminRefusal,
} from '../merchants/merchant-admin';

export type ListMerchantsInput = Readonly<Record<string, never>>;

export interface MerchantRow {
  readonly merchantId: Id<'Merchant'>;
  readonly name: string;
  readonly state: MerchantStateCode;
  readonly stateChangedAt: Temporal.Instant;
  readonly createdAt: Temporal.Instant;
}

export interface ListMerchantsOutput {
  readonly items: readonly MerchantRow[];
}

/**
 * The merchants of the Market by name (Drive). Rule `permissions [identity.merchant.view]`. A
 * Market holds few merchants at launch, so the list is not paged yet.
 */
export class ListMerchants extends UseCase<
  ListMerchantsInput,
  ListMerchantsOutput,
  MerchantAdminRefusal
> {
  static override readonly access: AccessDeclaration = {
    name: 'identity.list-merchants',
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
  ): Promise<Result<ListMerchantsOutput, MerchantAdminRefusal>> {
    return asActingAdmin(
      this.deps,
      context,
      'identity.list-merchants',
      [MERCHANT_VIEW.key],
      async (): Promise<Result<ListMerchantsOutput, never>> => {
        const merchants = await this.deps.merchants.list(context.market);
        return ok({
          items: merchants.map(({ state }) => ({
            merchantId: state.id,
            name: state.name,
            state: state.state,
            stateChangedAt: state.stateChangedAt,
            createdAt: state.createdAt,
          })),
        });
      },
      (value) => ({ merchants: String(value.items.length) }),
    );
  }
}
