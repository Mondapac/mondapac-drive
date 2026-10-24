import { Controller, Get, Header, type MessageEvent, Param, Sse, SseSignal } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { CallContext, Result } from '@mondapac-drive/shared-kernel';
import {
  concatMap,
  EMPTY,
  finalize,
  from,
  map,
  take,
  takeWhile,
  timer,
  type Observable,
} from 'rxjs';
import { Call } from '../../../platform/call-context/call-context.decorator';
import { RoutePopulation } from '../../../platform/call-context/route-population.decorator';
import { ViewTrackingLink } from '../application/use-cases/view-tracking-link.use-case';
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

function eventOf(result: Result<CustomerView, { readonly code: string }>): MessageEvent {
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
  async view(@Call() context: CallContext, @Param('token') token: string) {
    if (!TOKEN_PARAM.test(token)) throw fail(404, 'tracking.link-not-found');
    return present(answer(await this.viewLink.execute(context, { token })));
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
  stream(
    @Call() context: CallContext,
    @Param('token') token: string,
    @SseSignal() signal: AbortSignal,
  ): Observable<MessageEvent> {
    if (!TOKEN_PARAM.test(token)) throw fail(404, 'tracking.link-not-found');
    const release = this.#streams.acquire(token);
    if (release === undefined) {
      throw fail(429, 'tracking.too-many-streams', { retryAfterSeconds: 60 });
    }
    // The slot goes back when the request closes, however it closes, as on the dispatcher map
    // (handoff 26), and not only when Nest unsubscribes.
    signal.addEventListener('abort', release, { once: true });
    if (signal.aborted) {
      release();
      return EMPTY;
    }
    const everyMs = this.viewLink.refreshIntervalSeconds(context.market) * 1000;
    return timer(0, everyMs).pipe(
      take(Math.ceil((STREAM_MAX_SECONDS * 1000) / everyMs)),
      concatMap(() => from(this.viewLink.execute(context, { token }))),
      takeWhile((result) => result.ok, true),
      map(eventOf),
      // Runs on completion and when the client disconnects (Nest unsubscribes on close).
      finalize(release),
    );
  }
}
