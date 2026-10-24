import { Logger } from '@nestjs/common';
import { Temporal } from '@mondapac-drive/shared-kernel';
import { TEST_MARKETS, testMarketId } from '../../../test/support/test-config';
import { LogAnchorSink, type ChainAnchor } from './anchor-sink';
import { chainHashText } from './audit-hash';

// The Phase 2 anchor (docs/design/domain/platform-audit.md 8): one info line per checkpoint
// and per heartbeat, through the Nest logger, in a shape a log pipeline can store as JSON
// (Sajad, 6b review M1).

describe.each(TEST_MARKETS)('LogAnchorSink for market %s', (code) => {
  const anchor: ChainAnchor = {
    marketId: testMarketId(code),
    epoch: 1,
    chainSeq: 9_007_199_254_740_993n,
    chainHash: chainHashText(new Uint8Array(32).fill(0xab)),
    hashVersion: 1,
    at: Temporal.Instant.from('2026-10-08T06:00:00.123Z'),
  };
  let infos: jest.SpyInstance;

  beforeEach(() => {
    infos = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it.each([
    ['checkpoint', 'audit.checkpoint'],
    ['heartbeat', 'audit.heartbeat'],
  ] as const)('writes the %s as one info line with chain_seq as text', async (kind, msg) => {
    const sink = new LogAnchorSink();

    await expect(sink[kind](anchor)).resolves.toBeUndefined();

    expect(infos).toHaveBeenCalledTimes(1);
    const [line] = infos.mock.calls[0] as [Record<string, unknown>];
    expect(line).toEqual({
      msg,
      marketId: code,
      epoch: 1,
      // Past 2^53: a bigint written as a number would lose its last digits.
      chainSeq: '9007199254740993',
      chainHash: `sha256:${'ab'.repeat(32)}`,
      hashVersion: 1,
      at: '2026-10-08T06:00:00.123Z',
    });
    // The line survives JSON as it is: no bigint, no Temporal object.
    expect(JSON.parse(JSON.stringify(line))).toEqual(line);
  });
});
