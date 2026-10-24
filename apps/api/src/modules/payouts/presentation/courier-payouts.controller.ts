import { Controller, Get, Header, HttpCode, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { CallContext } from '@mondapac-drive/shared-kernel';
import { Call } from '../../../platform/call-context/call-context.decorator';
import {
  ReadsSession,
  RoutePopulation,
} from '../../../platform/call-context/route-population.decorator';
import {
  GetCourierBalance,
  GetEarningsSummary,
} from '../application/use-cases/get-courier-balance.use-case';
import { StartPayoutOnboarding } from '../application/use-cases/start-payout-onboarding.use-case';
import { answer, entryBody, moneyBody, parsed } from './payouts-http';
import { statementQuery } from './payouts.schemas';

/**
 * The courier app's earnings API (`Authorization: Bearer <session token>`): the signed-in
 * courier's own summary, balance and payout onboarding. The courier is the session's account,
 * never a path or body field.
 */
@ApiTags('payouts')
@ApiBearerAuth()
@RoutePopulation('courier')
@Controller('payouts/courier/me')
export class CourierPayoutsController {
  constructor(
    private readonly summary: GetEarningsSummary,
    private readonly balance: GetCourierBalance,
    private readonly onboarding: StartPayoutOnboarding,
  ) {}

  @Get('summary')
  @ReadsSession()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: "The courier's earnings today and this week, and today's deliveries",
    description: 'Days and weeks (from Monday) are local to the Market. Money is minor units.',
  })
  async getSummary(@Call() context: CallContext) {
    const found = answer(await this.summary.execute(context, {}));
    return {
      today: moneyBody(found.today),
      week: moneyBody(found.week),
      deliveriesToday: found.deliveriesToday,
    };
  }

  @Get('balance')
  @ReadsSession()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: "The courier's balance and latest ledger entries, newest first" })
  async getBalance(@Call() context: CallContext, @Query() query: unknown) {
    const input = parsed(() => statementQuery.parse(query));
    const found = answer(await this.balance.execute(context, input));
    return {
      balance: {
        amount: moneyBody(found.balance.amount),
        tax: moneyBody(found.balance.tax),
        total: moneyBody(found.balance.total),
      },
      entries: found.entries.map(entryBody),
    };
  }

  @Post('onboarding-link')
  @HttpCode(200)
  @ReadsSession()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: "A short-lived link to the payment provider's onboarding of the courier's account",
    description:
      'Contractors only (409 `payouts.not-a-contractor`). Creates the connected account on the ' +
      'first call; 503 `payouts.provider-unavailable` when no provider is configured.',
  })
  async onboardingLink(@Call() context: CallContext) {
    const link = answer(await this.onboarding.execute(context, {}));
    return { url: link.url, expiresAt: link.expiresAt.toString() };
  }
}
