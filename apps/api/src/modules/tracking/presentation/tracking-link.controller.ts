import { Controller, Get, Header, type MessageEvent, Param, Sse } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { MarketContext, Result } from '@mondapac-drive/shared-kernel';
import { concatMap, finalize, from, map, take, takeWhile, timer, type Observable } from 'rxjs';
import { Market } from '../../../platform/market-context/market.decorator';
import { RoutePopulation } from '../../../platform/call-context/route-population.decorator';
import {
  ViewTrackingLink,
  type TrackingFailure,
} from '../application/use-cases/view-tracking-link.use-case';
import type { CustomerView } from '../domain/tracking-link';
import { answer, fail } from './tracking-http';
import { StreamLimits } from './stream-limits';
import { TOKEN_PARAM } from './tracking.schemas';

/** A live channel closes after this long; the browser's EventSource reconnects by itself. */
const STREAM_MAX_SECONDS = 30 * 60;

function present(view: CustomerView) {
  if (!('courier' in view) || view.courier === undefined) return view;
  return { ...view, courier: { ...view.courier, recordedAt: view.courier.recordedAt.toString() } };
}

function eventOf(result: Result<CustomerView, TrackingFailure>): MessageEvent {
  return result.ok
    ? { type: 'view', data: present(result.value) }
    : { type: 'end', data: { code: result.error.code } };
}

/**
 * The customer's tracking page. No login: the unguessable token is the credential, and it
 * shows only the phase, the ETA and the courier's position from pickup until drop-off. An
 * unknown, expired or ended link answers a code and nothing else. Scoped to the request's
 * Market (`x-market-id`, set by the tier in front of the API) and its default rate limit.
 */
@ApiTags('tracking')
// Anonymous: no @ReadsSession, so no credential is read and a bearer header is refused. The
// population is the merchant's (its recipients follow the link); a GET has no origin check.
@RoutePopulation('merchant')
@Controller('tracking')
export class TrackingLinkController {
  readonly #streams = new StreamLimits();

  constructor(private readonly viewLink: ViewTrackingLink) {}

  @Get('links/:token')
  @Header('Cache-Control', 'no-store')
  @Header('Referrer-Policy', 'no-referrer')
  @ApiOperation({ summary: 'What a customer tracking link shows now' })
  async view(@Market() market: MarketContext, @Param('token') token: string) {
    if (!TOKEN_PARAM.test(token)) throw fail(404, 'tracking.link-not-found');
    return present(answer(await this.viewLink.perform(market, token)));
  }

  @Sse('links/:token/stream')
  @Header('Cache-Control', 'no-store')
  @Header('Referrer-Policy', 'no-referrer')
  @ApiOperation({
    summary: 'Server-sent events of a tracking link',
    description:
      'A `view` event every few seconds (Market setting) until the link expires or the ' +
      'delivery ends; then one `end` event with the code, and the stream closes. At most three ' +
      'streams of one link are open at once (429 `tracking.too-many-streams`).',
  })
  stream(@Market() market: MarketContext, @Param('token') token: string): Observable<MessageEvent> {
    if (!TOKEN_PARAM.test(token)) throw fail(404, 'tracking.link-not-found');
    const release = this.#streams.acquire(token);
    if (release === undefined) {
      throw fail(429, 'tracking.too-many-streams', { retryAfterSeconds: 60 });
    }
    const everyMs = this.viewLink.refreshIntervalSeconds(market) * 1000;
    return timer(0, everyMs).pipe(
      take(Math.ceil((STREAM_MAX_SECONDS * 1000) / everyMs)),
      concatMap(() => from(this.viewLink.perform(market, token))),
      takeWhile((result) => result.ok, true),
      map(eventOf),
      finalize(release),
    );
  }
}
