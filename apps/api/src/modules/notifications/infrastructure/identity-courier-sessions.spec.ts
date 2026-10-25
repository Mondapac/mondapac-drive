import { err, ok } from '@mondapac-drive/shared-kernel';
import { testCallContext, testMarketContext } from '@mondapac-drive/shared-kernel/testing';
import type { IdentityFacade } from '../../identity';
import { IdentityCourierSessions } from './identity-courier-sessions';

const ACCOUNT = '0195f000-0000-7000-8000-0000000000a1';
const SESSION = '0195f000-0000-7000-8000-0000000000b1';

describe("notifications' read of live courier sessions", () => {
  const context = testCallContext(testMarketContext('AU', 'default'), 'system', 'push-sess-0001');
  const over = (liveSessionsOf: IdentityFacade['liveSessionsOf']) =>
    new IdentityCourierSessions({ liveSessionsOf } as IdentityFacade);

  it("answers identity's live set", async () => {
    const sessions = over(() => Promise.resolve(ok(new Set([SESSION]))));
    expect(await sessions.liveOf(context, ACCOUNT, [SESSION])).toEqual(new Set([SESSION]));
  });

  it('answers unknown, never "none live", when identity refuses or fails', async () => {
    const refused = over(() => Promise.resolve(err({ code: 'identity.unavailable' as const })));
    expect(await refused.liveOf(context, ACCOUNT, [SESSION])).toBeUndefined();
    const failing = over(() => Promise.reject(new Error('database down')));
    expect(await failing.liveOf(context, ACCOUNT, [SESSION])).toBeUndefined();
  });
});
