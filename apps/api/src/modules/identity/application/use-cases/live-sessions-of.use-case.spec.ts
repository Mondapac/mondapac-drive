import { err, ok, Temporal, type Id } from '@mondapac-drive/shared-kernel';
import { testCallContext, testMarketContext } from '@mondapac-drive/shared-kernel/testing';
import { expectSystemOnly, openGate } from '../../../../../test/support/system-only-denial';
import { TEST_MARKET_IDS } from '../../../../../test/support/test-config';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import type { Session } from '../../domain/session';
import type { SessionRepository } from '../ports/session.repository';
import { LiveSessionsOf } from './live-sessions-of.use-case';

const NOW = Temporal.Instant.from('2026-11-02T12:00:00Z');
const ACCOUNT = '0195f000-0000-7000-8000-0000000000a1' as Id<'Account'>;
const sid = (n: number) => `0195f000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;

describe.each(TEST_MARKET_IDS)('liveSessionsOf in %s', (marketId) => {
  const market = testMarketContext(marketId, 'default');
  const system = testCallContext(market, 'system', 'live-sessions-0001');
  const session = (n: number, over: Partial<Session> = {}): Session =>
    ({
      id: sid(n),
      marketId,
      accountId: ACCOUNT,
      population: 'courier',
      merchantId: null,
      transport: 'bearer',
      label: null,
      device: null,
      createdAt: NOW.subtract({ hours: 2 }),
      lastSeenAt: NOW.subtract({ minutes: 5 }),
      idleTimeoutSeconds: 3600,
      absoluteExpiresAt: NOW.add({ hours: 2 }),
      revokedAt: null,
      revokedReason: null,
      ...over,
    }) as Session;
  const stored = [
    session(1),
    session(2, { lastSeenAt: NOW.subtract({ hours: 2 }) }),
    session(3, { revokedAt: NOW, revokedReason: 'signed-out' }),
  ];
  const useCase = (unitOfWork: Partial<UnitOfWork>) =>
    new LiveSessionsOf(openGate(), {
      unitOfWork: unitOfWork as UnitOfWork,
      sessions: {
        listUnrevokedOf: () => Promise.resolve(stored),
      } as unknown as SessionRepository,
      clock: { now: () => NOW },
    });
  const running: Partial<UnitOfWork> = {
    run: (_m, work) => work(),
  };

  it('answers the asked sessions that live: not idle, not revoked, not unknown', async () => {
    expect(
      await useCase(running).execute(system, {
        accountId: ACCOUNT,
        sessionIds: [sid(1), sid(2), sid(3), sid(9)],
      }),
    ).toEqual(ok(new Set([sid(1)])));
  });

  it('refuses a failed read instead of answering that none live', async () => {
    const failing: Partial<UnitOfWork> = {
      run: () => Promise.resolve(err({ code: 'database.unavailable' })) as never,
    };
    expect(
      await useCase(failing).execute(system, { accountId: ACCOUNT, sessionIds: [sid(1)] }),
    ).toEqual(err({ code: 'identity.unavailable' }));
  });

  it('is the system actor’s only', async () => {
    await expectSystemOnly(marketId as 'AU' | 'ZZ', (context) =>
      useCase(running).execute(context, { accountId: ACCOUNT, sessionIds: [sid(1)] }),
    );
  });
});
