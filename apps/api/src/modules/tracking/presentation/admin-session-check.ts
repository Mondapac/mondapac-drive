import type { IncomingMessage } from 'node:http';
import { Inject, Injectable } from '@nestjs/common';
import type { CallContext } from '@mondapac-drive/shared-kernel';
import { AUTHENTICATOR, type Authenticator } from '../../../platform/authz';
import { readCookie, sessionCookieName } from '../../../platform/call-context/session-cookie';

/** Answers whether the session that opened a stream is still live. Never throws. */
export type SessionStillLive = () => Promise<boolean>;

/**
 * Re-checks an admin's panel session while a live stream is open (security review of tracking
 * 06b, L1). The gate's per-tick check sees a disabled account or a removed role, but not a
 * signed-out or revoked session; identity's Authenticator does, because it reads the session on
 * every call. The check holds the request's own session cookie in memory for the life of the
 * stream, never logs or stores it, and answers false (the stream ends) when the session is no
 * longer the one the stream opened with, or when the check itself fails (fail closed).
 */
@Injectable()
export class AdminSessionCheck {
  constructor(@Inject(AUTHENTICATOR) private readonly authenticator: Authenticator) {}

  /** The check of the stream's session; one that always answers false without a session. */
  of(request: IncomingMessage, context: CallContext): SessionStillLive {
    const { actor, market } = context;
    if (actor.kind !== 'authenticated' || actor.population !== 'admin') {
      return () => Promise.resolve(false);
    }
    const cookie = readCookie(request.headers.cookie, sessionCookieName('admin', market.marketId));
    if (cookie.kind !== 'one') return () => Promise.resolve(false);
    const token = cookie.value;
    return async () => {
      try {
        // `touch: false`: an open map is not the admin's activity, so the session still idles
        // out (security review of PR #18, M1).
        const again = await this.authenticator.authenticate(
          market,
          { token, transport: 'cookie' },
          { touch: false },
        );
        return (
          again.ok &&
          again.value.sessionId === actor.sessionId &&
          again.value.accountId === actor.accountId
        );
      } catch {
        return false;
      }
    };
  }
}
