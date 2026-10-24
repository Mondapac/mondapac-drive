import { err, ok } from '@mondapac-drive/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac-drive/shared-kernel';
import type { AccessDenied } from '../../../platform/authz';
import type { ContactEmailOf } from '../application/use-cases/contact-email-of.use-case';
import type { DescribeActor } from '../application/use-cases/describe-actor.use-case';
import type { ActorDescription, IdentityFacade } from '../contracts/identity.facade';

/** The use cases behind the facade, one per method. */
export interface IdentityFacadeUseCases {
  readonly describeActor: DescribeActor;
  readonly contactEmailOf: ContactEmailOf;
}

/**
 * The implementation of {@link IdentityFacade} (identity design 8.1): each method passes the
 * caller's `CallContext` unchanged to one use case through `execute`, so the gate runs, and
 * returns ids and codes only: the name and the email of the HTTP summary are dropped here.
 */
export class IdentityFacadeImplementation implements IdentityFacade {
  constructor(private readonly useCases: IdentityFacadeUseCases) {}

  async describeActor(context: CallContext): Promise<Result<ActorDescription, AccessDenied>> {
    const result = await this.useCases.describeActor.execute(context, {});
    // A summary that vanished under a concurrent revocation is `access.denied`, as the gate's.
    if (!result.ok) return err(result.error);
    const summary = result.value;
    return ok({
      accountId: summary.accountId,
      population: summary.population,
      merchantId: summary.merchantId,
      roleId: summary.roleId,
      permissionKeys: summary.permissionKeys,
      merchantState: summary.merchantState,
      secondFactorActive: summary.secondFactorActive,
    });
  }

  contactEmailOf(
    context: CallContext,
    accountId: Id<'Account'>,
  ): Promise<Result<string | null, AccessDenied>> {
    return this.useCases.contactEmailOf.execute(context, { accountId });
  }
}
