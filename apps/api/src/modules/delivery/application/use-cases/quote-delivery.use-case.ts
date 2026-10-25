import { err } from '@mondapac-drive/shared-kernel';
import type { CallContext, Result } from '@mondapac-drive/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { QUOTE_CREATE } from '../../contracts/permissions';
import { ACCESS_DENIED, merchantOf } from '../deliveries';
import type { DeliveryFailure } from '../failure';
import type { DeliveryPricing, QuoteDeliveryInput, QuoteDeliveryResult } from '../pricing';

export type { DeliveryFailure, QuoteDeliveryInput, QuoteDeliveryResult };

export interface QuoteDeliveryDependencies {
  readonly pricing: DeliveryPricing;
}

/**
 * Prices a delivery without booking it, for the merchant of the API key. Rule `permissions
 * [delivery.quote.create]`, which only the merchant role holds. Nothing is stored.
 */
export class QuoteDelivery extends UseCase<
  QuoteDeliveryInput,
  QuoteDeliveryResult,
  DeliveryFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'delivery.quote-delivery',
    rule: { kind: 'permissions', allOf: [QUOTE_CREATE.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: QuoteDeliveryDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: QuoteDeliveryInput,
  ): Promise<Result<QuoteDeliveryResult, DeliveryFailure>> {
    const merchantId = merchantOf(context);
    if (merchantId === null) return Promise.resolve(err(ACCESS_DENIED));
    return this.deps.pricing.price(context.market, input, merchantId);
  }
}
