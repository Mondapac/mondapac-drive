import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { money, type CallContext, type Id } from '@mondapac-drive/shared-kernel';
import { Call } from '../../../platform/call-context/call-context.decorator';
import {
  ReadsSession,
  RoutePopulation,
} from '../../../platform/call-context/route-population.decorator';
import { ViewCourierBalance } from '../application/use-cases/get-courier-balance.use-case';
import { ListPayoutLines } from '../application/use-cases/list-payout-lines.use-case';
import { RecordAdjustment } from '../application/use-cases/record-adjustment.use-case';
import { SettleUnresolvedLine } from '../application/use-cases/settle-unresolved-line.use-case';
import { answer, entryBody, fail, lineBody, moneyBody, parsed } from './payouts-http';
import { adjustmentBody, ID_PARAM, lineQuery, statementQuery } from './payouts.schemas';

function idOf<B extends string>(value: string, code: string): Id<B> {
  if (!ID_PARAM.safeParse(value).success) throw fail(404, code);
  return value as Id<B>;
}

/**
 * The operations panel's payouts API (the admin session cookie): payout lines (held with their
 * reason, unresolved, failed), a courier's balance, adjustments and the stuck-payout tool.
 * Reading needs `payouts.ledger.view`; adjusting a balance and settling a line move money and
 * need the protected `payouts.adjustment.record` and `payouts.line.settle`, both audited.
 */
@ApiTags('payouts')
@RoutePopulation('admin')
@Controller('payouts/admin')
export class AdminPayoutsController {
  constructor(
    private readonly lines: ListPayoutLines,
    private readonly balance: ViewCourierBalance,
    private readonly adjust: RecordAdjustment,
    private readonly settle: SettleUnresolvedLine,
  ) {}

  @Get('lines')
  @ReadsSession()
  @ApiOperation({
    summary: 'Payout lines by status, oldest first',
    description: '`status` is a comma-separated list (default `held,unresolved`); `after` pages.',
  })
  async listLines(@Call() context: CallContext, @Query() query: unknown) {
    const input = parsed(() => lineQuery.parse(query));
    const page = answer(
      await this.lines.execute(context, {
        statuses: input.status,
        ...(input.courierId === undefined ? {} : { courierId: input.courierId }),
        ...(input.limit === undefined ? {} : { limit: input.limit }),
        ...(input.after === undefined ? {} : { after: input.after as Id<'PayoutLine'> }),
      }),
    );
    return {
      lines: page.lines.map(lineBody),
      ...(page.next === undefined ? {} : { next: page.next }),
    };
  }

  @Get('couriers/:courierId/balance')
  @ReadsSession()
  @ApiOperation({ summary: "A courier's balance and latest ledger entries" })
  async courierBalance(
    @Call() context: CallContext,
    @Param('courierId') courierId: string,
    @Query() query: unknown,
  ) {
    const input = parsed(() => statementQuery.parse(query));
    const found = answer(
      await this.balance.execute(context, {
        ...input,
        courierId: idOf<'Account'>(courierId, 'payouts.unknown-courier'),
      }),
    );
    return {
      balance: {
        amount: moneyBody(found.balance.amount),
        tax: moneyBody(found.balance.tax),
        total: moneyBody(found.balance.total),
      },
      entries: found.entries.map(entryBody),
    };
  }

  @Post('couriers/:courierId/adjustments')
  @HttpCode(200)
  @ReadsSession()
  @ApiOperation({
    summary: "Credit or debit a courier's balance (audited)",
    description:
      'Amount before tax, in minor units; the tax a service payment carries is added. `key` makes ' +
      'a retry record nothing new (409 `payouts.key-reused` for a different adjustment).',
  })
  async recordAdjustment(
    @Call() context: CallContext,
    @Param('courierId') courierId: string,
    @Body() body: unknown,
  ) {
    const id = idOf<'Account'>(courierId, 'payouts.unknown-courier');
    const input = parsed(() => adjustmentBody.parse(body));
    const recorded = answer(
      await this.adjust.execute(context, {
        courierId: id,
        amount: money(BigInt(input.amount.amount), input.amount.currency),
        reason: input.reason,
        key: input.key,
      }),
    );
    return { recorded: recorded.recorded, entry: entryBody(recorded.entry) };
  }

  @Post('lines/:lineId/settle')
  @HttpCode(200)
  @ReadsSession()
  @ApiOperation({
    summary: "Settle an unresolved payout line against the provider's transfers (audited)",
    description:
      'Transferred when the provider holds its transfer, failed (debit reversed) when it holds ' +
      'none; 409 `payouts.settle-mismatch` or `payouts.settle-ambiguous` for a person to check. ' +
      'See docs/runbooks/payouts-unresolved-line.md.',
  })
  async settleLine(@Call() context: CallContext, @Param('lineId') lineId: string) {
    const settled = answer(
      await this.settle.execute(context, {
        lineId: idOf<'PayoutLine'>(lineId, 'payouts.line-not-found'),
      }),
    );
    return { line: lineBody(settled.line), providerTransferFound: settled.providerTransferFound };
  }
}
