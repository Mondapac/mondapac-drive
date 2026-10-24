import {
  err,
  ok,
  Temporal,
  type CallContext,
  type Id,
  type Result,
} from '@mondapac-drive/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { LINE_SETTLE } from '../../contracts/permissions';
import { lineSettledAudit } from '../../domain/audit-actions';
import { eventsOfLine } from '../../domain/events';
import {
  lineSettled,
  transferAmountOf,
  type PayoutLine,
  type Settlement,
} from '../../domain/payout-run';
import { isAdmin } from '../callers';
import type { PayoutsDependencies } from '../dependencies';
import { ACCESS_DENIED, refusingBrokenRules, type PayoutsFailure } from '../failure';
import { reverseDebitOf } from '../line-debits';

export interface SettleLineInput {
  readonly lineId: Id<'PayoutLine'>;
}

export interface SettledLine {
  readonly line: PayoutLine;
  /** Whether the provider holds a transfer of this line. */
  readonly providerTransferFound: boolean;
}

const failure = (code: string, message: string): PayoutsFailure => ({ code, message });

/** How long a line stays unresolved before it may be settled as not transferred. */
export const SETTLE_NOT_FOUND_AFTER = Temporal.Duration.from({ hours: 1 });

/**
 * The stuck-payout tool (docs/runbooks/payouts-unresolved-line.md): settles an `unresolved` line,
 * one whose transfer ran out of attempts on transient refusals, against the provider's records.
 * It lists the provider's transfers of the line's run (`transfer_group` is the run id) and looks
 * for the one whose `metadata.payoutLineId` is the line:
 *
 * - found, with the line's amount and destination: the line is `transferred` with it;
 * - none: the line is `failed` and its debit is reversed, so a later run pays the balance under
 *   a new line;
 * - found but different, or more than one: refused, for a person to investigate at the provider.
 *
 * The line must still be unresolved, at the version read, when the unit writes. Audited, and
 * published as `payouts.line-transferred` or `payouts.line-failed`. Rule
 * `permissions [payouts.line.settle]` (protected), admins only.
 */
export class SettleUnresolvedLine extends UseCase<SettleLineInput, SettledLine, PayoutsFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'payouts.settle-unresolved-line',
    rule: { kind: 'permissions', allOf: [LINE_SETTLE.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: PayoutsDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: SettleLineInput,
  ): Promise<Result<SettledLine, PayoutsFailure>> {
    if (!isAdmin(context)) return err(ACCESS_DENIED);
    const { market } = context;
    const { runs, ledger, gateway, outbox, audit, unitOfWork, clock, ids } = this.deps;
    const read = await unitOfWork.run(
      market,
      async () => ok(await runs.findLine(market, input.lineId)),
      { readOnly: true },
    );
    if (!read.ok) return read;
    const line = read.value;
    if (line === undefined) return err(failure('payouts.line-not-found', 'No such payout line'));
    if (line.status !== 'unresolved') {
      return err(failure('payouts.line-state', `A ${line.status} line needs no settling`));
    }
    if (!gateway.enabled) {
      return err(
        failure('payouts.provider-unavailable', 'Payouts are not connected to a payment provider'),
      );
    }
    const listed = await gateway.transfersOfGroup(line.runId);
    if (!listed.ok) {
      return err(
        failure('payouts.provider-unavailable', 'The payment provider did not list the transfers'),
      );
    }
    const matches = listed.value.filter((transfer) => transfer.payoutLineId === line.id);
    if (matches.length > 1) {
      return err(failure('payouts.settle-ambiguous', 'The provider holds several transfers'));
    }
    const match = matches[0];
    if (match === undefined) {
      // "Not transferred" credits the courier back for the next run, so it is answered only when
      // the provider has had time to list a transfer of the last attempt (Hassan L-b) and no
      // transfer of the run could be this line's with its metadata lost.
      const unresolvedFor = clock.now().since(line.updatedAt);
      if (Temporal.Duration.compare(unresolvedFor, SETTLE_NOT_FOUND_AFTER) < 0) {
        return err(
          failure('payouts.settle-too-early', 'The provider may not list the transfer yet'),
        );
      }
      const lookalike = listed.value.some(
        (transfer) =>
          transfer.payoutLineId === undefined &&
          transfer.destination === line.destination &&
          transfer.amount.currency === line.amount.currency &&
          transfer.amount.amount === transferAmountOf(line).amount,
      );
      if (lookalike) {
        return err(
          failure('payouts.settle-ambiguous', 'A transfer without its line id may be this line'),
        );
      }
    }
    if (
      match !== undefined &&
      (match.destination !== line.destination ||
        match.amount.currency !== line.amount.currency ||
        match.amount.amount !== transferAmountOf(line).amount)
    ) {
      return err(
        failure('payouts.settle-mismatch', "The provider's transfer differs from the line"),
      );
    }
    const settlement: Settlement =
      match === undefined ? { found: false } : { found: true, transferId: match.transferId };

    return refusingBrokenRules(() =>
      unitOfWork.run<SettledLine, PayoutsFailure>(market, async () => {
        const current = await runs.findLine(market, line.id);
        if (current?.status !== 'unresolved' || current.version !== line.version) {
          return err(failure('payouts.line-state', 'The line changed; read it again'));
        }
        const now = clock.now();
        const settled = lineSettled(current, settlement, now);
        await runs.updateLine(market, settled);
        if (settled.status === 'failed') {
          const reversal = await reverseDebitOf(ledger, market, settled, {
            id: ids.next<'LedgerEntry'>(),
            reason: 'transfer-failed',
            at: now,
          });
          if (reversal !== undefined) await ledger.append(market, [reversal]);
        }
        await outbox.append(context, eventsOfLine(settled));
        await audit.record(
          context,
          lineSettledAudit.entry(settled.id, {
            before: { status: current.status },
            after: {
              status: settled.status,
              courierId: settled.courierId as Id,
              providerTransferFound: settlement.found,
            },
          }),
        );
        return ok({ line: settled, providerTransferFound: settlement.found });
      }),
    );
  }
}
