import { randomBytes } from 'node:crypto';
import { err, ok } from '@mondapac-drive/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac-drive/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { MERCHANT_CREATE } from '../../contracts/permissions';
import { Account } from '../../domain/account';
import { MerchantCreatedAudit } from '../../domain/audit';
import { parseEmailAddress } from '../../domain/email-address';
import { foundMerchantMembership, Merchant, parseMerchantName } from '../../domain/merchant';
import { RoleAssignment } from '../../domain/role';
import {
  asActingAdmin,
  type MerchantAdminDependencies,
  type MerchantAdminRefusal,
} from '../merchants/merchant-admin';
import type { AccountRepository } from '../ports/account.repository';
import type { PasswordHasher, PasswordHasherBusy } from '../ports/password-hasher';
import type { RoleAssignmentRepository, RoleRepository } from '../ports/role.repository';
import type { FieldProblem } from '../field-problem';

/**
 * The integration account's address: a reserved name under the `.invalid` top-level domain (RFC
 * 2606), so no mail can ever reach it and no person can sign up with it.
 */
export function integrationEmailOf(merchantId: Id<'Merchant'>): string {
  return `${merchantId}@merchant.invalid`;
}

export interface CreateMerchantInput {
  /** The business's name, as operators see it. Never logged or audited. */
  readonly name: string;
}

export interface CreateMerchantOutput {
  readonly code: 'merchant.created';
  readonly merchantId: Id<'Merchant'>;
}

export type CreateMerchantFailure =
  | { readonly code: 'validation.failed'; readonly fields: readonly FieldProblem[] }
  | PasswordHasherBusy
  | MerchantAdminRefusal;

export interface CreateMerchantDependencies extends MerchantAdminDependencies {
  readonly accounts: AccountRepository;
  readonly roles: Pick<RoleRepository, 'findSystemRole'>;
  readonly assignments: Pick<RoleAssignmentRepository, 'add'>;
  readonly hasher: PasswordHasher;
}

/**
 * Creates a merchant (Drive): the business that books deliveries through the API. Rule
 * `permissions [identity.merchant.create]` (protected). In one unit, with the actor read again:
 * the merchant `active`; its integration account, the principal its API keys act as (an
 * unverified merchant-population account with the hash of a random secret nobody holds, so no
 * password ever signs it in); the founding membership; and the founding assignment of the
 * merchant system role. Audited as `identity.merchant.created` with ids only. No key is issued:
 * that is {@link IssueMerchantApiKey}.
 */
export class CreateMerchant extends UseCase<
  CreateMerchantInput,
  CreateMerchantOutput,
  CreateMerchantFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'identity.create-merchant',
    rule: { kind: 'permissions', allOf: [MERCHANT_CREATE.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: CreateMerchantDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: CreateMerchantInput,
  ): Promise<Result<CreateMerchantOutput, CreateMerchantFailure>> {
    const name = parseMerchantName(input.name);
    if (!name.ok) {
      return err({ code: 'validation.failed', fields: [{ path: 'name', code: name.error.rule }] });
    }
    // Outside any unit: the hash of a secret that is thrown away at once.
    const hashed = await this.deps.hasher.hash(randomBytes(32).toString('base64url'));
    if (!hashed.ok) return err(hashed.error);
    const { market } = context;
    return asActingAdmin(
      this.deps,
      context,
      'identity.create-merchant',
      [MERCHANT_CREATE.key],
      async (): Promise<Result<CreateMerchantOutput, CreateMerchantFailure>> => {
        const now = this.deps.clock.now();
        const role = await this.deps.roles.findSystemRole(market, 'merchant');
        if (role === null) return err({ code: 'access.unavailable' });
        const merchant = Merchant.create({
          id: this.deps.ids.next<'Merchant'>(),
          marketId: market.marketId,
          name: name.value,
          now,
        });
        const merchantId = merchant.state.id;
        const email = parseEmailAddress(integrationEmailOf(merchantId));
        if (!email.ok) throw new Error('CreateMerchant: the integration address does not parse');
        const account = Account.createMerchantIntegration({
          id: this.deps.ids.next<'Account'>(),
          marketId: market.marketId,
          email: email.value,
          displayName: name.value,
          passwordHash: hashed.value,
          now,
        });
        await this.deps.merchants.add(market, merchant);
        const added = await this.deps.accounts.add(market, account);
        if (!added.ok) throw new Error('CreateMerchant: the integration account was refused');
        const accountId = account.state.id;
        await this.deps.memberships.add(
          market,
          foundMerchantMembership({
            id: this.deps.ids.next<'MerchantMembership'>(),
            marketId: market.marketId,
            accountId,
            merchantId,
            now,
          }),
        );
        await this.deps.assignments.add(
          market,
          RoleAssignment.found({
            id: this.deps.ids.next<'RoleAssignment'>(),
            account: { id: accountId, marketId: market.marketId, population: 'merchant' },
            role,
            now,
          }),
        );
        await this.deps.audit.record(
          context,
          MerchantCreatedAudit.entry(merchantId, {
            after: { state: 'active', accountId, roleId: role.state.id },
          }),
        );
        return ok({ code: 'merchant.created', merchantId });
      },
      (value) => ({ merchantId: value.merchantId }),
    );
  }
}
