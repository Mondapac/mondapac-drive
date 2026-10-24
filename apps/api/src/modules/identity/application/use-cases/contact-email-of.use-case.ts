import { err, ok } from '@mondapac-drive/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac-drive/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import type { AccountRepository } from '../ports/account.repository';

/** Whose address is wanted: an admin's or a courier's own. */
export interface ContactEmailInput {
  readonly accountId: Id<'Account'>;
}

export type ContactEmailFailure = { readonly code: 'access.denied' };

export interface ContactEmailOfDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly accounts: AccountRepository;
}

/**
 * `contactEmailOf`: the address to mail a notice to, read at send time and never stored or put
 * in an event or a log. Rule `system`. It answers the address of an admin or courier account of
 * the context's Market only when the account is active and its email is verified; otherwise
 * `null`, and the caller sends nothing. A merchant's integration account has no mailbox anyone
 * reads, so it answers `null` too. No reason is given: every miss answers alike.
 */
export class ContactEmailOf extends UseCase<ContactEmailInput, string | null, ContactEmailFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'identity.contact-email-of',
    rule: { kind: 'system' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: ContactEmailOfDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: ContactEmailInput,
  ): Promise<Result<string | null, ContactEmailFailure>> {
    const { market } = context;
    if (context.actor.kind !== 'system') return err({ code: 'access.denied' });
    const read = await this.deps.unitOfWork.run(
      market,
      async () => ok(await this.deps.accounts.findById(market, input.accountId)),
      { readOnly: true },
    );
    if (!read.ok) return ok(null);
    const account = read.value;
    const usable =
      account !== null &&
      account.state.population !== 'merchant' &&
      account.state.status === 'active' &&
      account.isEmailVerified;
    return ok(usable ? account.state.email.typed : null);
  }
}
