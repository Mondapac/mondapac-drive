import { err, ok, parseId } from '@mondapac-drive/shared-kernel';
import type { CallContext, Id, Result, Temporal } from '@mondapac-drive/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { COURIER_ACCOUNT_VIEW } from '../../contracts/permissions';
import { invitationStatusAt } from '../../domain/invitation';
import {
  asActingAdmin,
  type MerchantAdminDependencies,
  type MerchantAdminRefusal,
} from '../merchants/merchant-admin';
import type { AdminAccountReader, AdminAccountSummary } from '../ports/admin-account-reader';
import type { InvitationRepository, PendingInvitation } from '../ports/invitation.repository';

/** The largest page of the courier list; the route's default page is smaller. */
export const MAX_COURIER_PAGE = 100;

export interface ListCouriersInput {
  /** The last id of the previous page; absent or null for the first page. */
  readonly after?: string | null;
  readonly limit: number;
}

export interface CourierAccountRow {
  readonly type: 'account';
  readonly accountId: Id<'Account'>;
  readonly email: string;
  readonly displayName: string | null;
  readonly status: 'active' | 'disabled';
}

export interface CourierInvitationRow {
  readonly type: 'invitation';
  readonly invitationId: Id<'Invitation'>;
  readonly email: string;
  /** `expired`: past the expiry of its last mail. */
  readonly status: 'pending' | 'expired';
  readonly createdAt: Temporal.Instant;
  /** Null until its mail is sent. */
  readonly expiresAt: Temporal.Instant | null;
}

export type CourierRow = CourierAccountRow | CourierInvitationRow;

export interface CourierPage {
  /** Courier accounts and pending courier invitations, merged by id (UUIDv7: creation order). */
  readonly items: readonly CourierRow[];
  /** The `after` of the next page, or null when this page was the last. */
  readonly next: string | null;
}

export type ListCouriersFailure =
  | MerchantAdminRefusal
  | {
      readonly code: 'validation.failed';
      readonly fields: readonly { readonly path: string; readonly code: string }[];
    };

export interface ListCouriersDependencies extends MerchantAdminDependencies {
  readonly adminAccounts: AdminAccountReader;
  readonly invitations: InvitationRepository;
}

type PageEntry =
  | { readonly id: string; readonly account: AdminAccountSummary }
  | { readonly id: string; readonly invitation: PendingInvitation };

/**
 * The couriers of the Market for the operations panel (Drive): courier accounts with their
 * status, and pending courier invitations, merged by id and paged as the admin team list is.
 * Rule `permissions [identity.courier-account.view]`, read again in the unit. The address and
 * the name are personal data: shown to the holder of the key, never logged.
 */
export class ListCouriers extends UseCase<ListCouriersInput, CourierPage, ListCouriersFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'identity.list-couriers',
    rule: { kind: 'permissions', allOf: [COURIER_ACCOUNT_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: ListCouriersDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: ListCouriersInput,
  ): Promise<Result<CourierPage, ListCouriersFailure>> {
    const { limit } = input;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_COURIER_PAGE) {
      return Promise.resolve(
        err({ code: 'validation.failed', fields: [{ path: 'limit', code: 'range' }] }),
      );
    }
    let after: string | null = null;
    if (input.after !== undefined && input.after !== null) {
      const parsed = parseId(input.after);
      if (!parsed.ok) {
        return Promise.resolve(
          err({ code: 'validation.failed', fields: [{ path: 'after', code: 'format' }] }),
        );
      }
      after = parsed.value;
    }
    const { market } = context;
    return asActingAdmin(
      this.deps,
      context,
      'identity.list-couriers',
      [COURIER_ACCOUNT_VIEW.key],
      async (): Promise<Result<CourierPage, never>> => {
        const now = this.deps.clock.now();
        // One row more of each than the page tells whether another page exists.
        const accounts = await this.deps.adminAccounts.courierAccounts(
          market,
          after as Id<'Account'> | null,
          limit + 1,
        );
        const invitations = await this.deps.invitations.pendingInvitations(
          market,
          'courier',
          after as Id<'Invitation'> | null,
          limit + 1,
        );
        const merged: PageEntry[] = [
          ...accounts.map((row) => ({ id: row.accountId, account: row })),
          ...invitations.map((row) => ({ id: row.id, invitation: row })),
        ].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
        const page = merged.slice(0, limit);
        const items = page.map((entry): CourierRow => {
          if ('account' in entry) {
            const { accountId, email, displayName, status } = entry.account;
            return { type: 'account', accountId, email, displayName, status };
          }
          const { invitation } = entry;
          return {
            type: 'invitation',
            invitationId: invitation.id,
            email: invitation.email,
            status: invitationStatusAt(invitation, now) === 'expired' ? 'expired' : 'pending',
            createdAt: invitation.createdAt,
            expiresAt: invitation.expiresAt,
          };
        });
        const more = merged.length > limit;
        return ok({ items, next: more ? page[page.length - 1]!.id : null });
      },
      (value) => ({ rows: String(value.items.length) }),
    );
  }
}
