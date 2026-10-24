import type { IncomingMessage } from 'node:http';
import { BadRequestException, HttpStatus, Injectable } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { MarketContextFactory, type MarketContextError } from './market-context.factory';
import { MARKET_PATH_PARAM, takesMarketFromPath } from '../http/market-from-path.decorator';
import { MARKET_ID_HEADER } from './market-id-header';
import { attachMarketContext } from './attached-market-context';
import { MARKET_CONTEXT_EXEMPTION } from './no-market-context.decorator';

/**
 * True when a controller class carries `@NoMarketContext()`. The class's own metadata only:
 * not a method's and not a parent class's. MarketContextGuard and the OpenAPI document both
 * ask this one predicate, so they always agree on which operations need the header.
 */
export function isMarketContextExempt(controller: object): boolean {
  return Reflect.getOwnMetadata(MARKET_CONTEXT_EXEMPTION.KEY, controller) === true;
}

/** The codes of the three answers of design 5.1; the body is `{ statusCode, code }` only. */
type MarketRejection = 'market.header-missing' | 'market.header-invalid' | 'market.not-hosted';

const REJECTION_OF: Record<MarketContextError['code'], MarketRejection> = {
  'market-id.invalid': 'market.header-invalid',
  'market.not-hosted': 'market.not-hosted',
};

function reject(code: MarketRejection): BadRequestException {
  // The received value is never echoed and never logged (design 5.1).
  return new BadRequestException({ statusCode: HttpStatus.BAD_REQUEST, code });
}

/**
 * Resolves the Market of every HTTP request from `x-market-id` (platform-foundations 5.1)
 * and attaches the minted context for `@Market()`. It is the first global guard, so a
 * request refused here reaches nothing else and reads nothing from the database. Every
 * controller is market-scoped unless its class carries `@NoMarketContext()`. A controller marked
 * `@MarketFromPath()` names its Market in the `:market` route parameter instead of the header;
 * the value is checked the same way and refused with the same codes.
 */
@Injectable()
export class MarketContextGuard implements CanActivate {
  constructor(private readonly factory: MarketContextFactory) {}

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') {
      throw new Error('MarketContextGuard resolves the Market of HTTP requests only');
    }
    if (isMarketContextExempt(context.getClass())) return true;

    const request = context
      .switchToHttp()
      .getRequest<IncomingMessage & { params?: Record<string, unknown> }>();
    const header = takesMarketFromPath(context.getClass())
      ? request.params?.[MARKET_PATH_PARAM]
      : request.headers[MARKET_ID_HEADER];
    if (header === undefined) throw reject('market.header-missing');
    // Node joins a repeated header into one string, which fails the Market pattern; an
    // array is refused the same way.
    if (typeof header !== 'string') throw reject('market.header-invalid');

    const market = this.factory.forMarket(header);
    if (!market.ok) throw reject(REJECTION_OF[market.error.code]);

    attachMarketContext(request, market.value);
    return true;
  }
}
