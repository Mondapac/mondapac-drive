import { ok, Temporal } from '@mondapac-drive/shared-kernel';
import { testCallContext, testMarketContext } from '@mondapac-drive/shared-kernel/testing';
import { openGate } from '../../../../../test/support/system-only-denial';
import { TEST_MARKET_IDS } from '../../../../../test/support/test-config';
import type { StoredObject } from '../../../../platform/storage/object-store';
import { documentPrefix } from '../document-files';
import type { FleetDependencies } from '../fleet-dependencies';
import { MAX_SWEEP_PAGES, SWEEP_PAGE, SweepDocumentFiles } from './sweep-document-files.use-case';

const T0 = Temporal.Instant.from('2026-11-02T00:00:00Z');

// The sweep keeps a cursor between runs (handoff 31): a Market with more stored files than one
// run reads is swept to the end over several runs, then starts over.
describe.each(TEST_MARKET_IDS)('sweep of document files in market %s', (code) => {
  const market = testMarketContext(code, 'default');
  const system = testCallContext(market, 'system');
  const perRun = SWEEP_PAGE * MAX_SWEEP_PAGES;

  function sweepOver(count: number, failReads = () => false) {
    const prefix = documentPrefix(market.marketId);
    const keys = Array.from(
      { length: count },
      (_, n) => `${prefix}/courier/${n.toString().padStart(6, '0')}`,
    );
    const old = T0.subtract({ hours: 2 });
    const files = {
      list: (_prefix: string, limit: number, after?: string): Promise<StoredObject[]> =>
        Promise.resolve(
          keys
            .filter((key) => after === undefined || key > after)
            .slice(0, limit)
            .map((key) => ({ key, writtenAt: old })),
        ),
      delete: jest.fn(() => Promise.resolve()),
    };
    const deps = {
      files,
      // Every file is named by a document row: nothing is removed, so only the cursor moves on.
      couriers: {
        namedFileKeys: (_m: unknown, ks: readonly string[]) => Promise.resolve(new Set(ks)),
      },
      // A failed read of the rows answers err, as a unit that could not run.
      unitOfWork: {
        run: (_m: unknown, work: () => Promise<unknown>) =>
          failReads() ? Promise.resolve({ ok: false, error: new Error('down') }) : work(),
      },
      clock: { now: () => T0 },
    } as unknown as FleetDependencies;
    return { sweep: new SweepDocumentFiles(openGate(), deps), files };
  }

  it('goes on where the last run stopped, and starts over after the end', async () => {
    const { sweep, files } = sweepOver(perRun + 600);
    const checked = async () => {
      const result = await sweep.execute(system, {});
      if (!result.ok) throw new Error(result.error.code);
      return result.value.checked;
    };

    expect(await checked()).toBe(perRun);
    expect(await checked()).toBe(600);
    expect(await checked()).toBe(perRun);
    expect(files.delete).not.toHaveBeenCalled();
  });

  it('starts over each run when one run reads every file', async () => {
    const { sweep } = sweepOver(SWEEP_PAGE + 1);
    for (let run = 0; run < 2; run += 1) {
      expect(await sweep.execute(system, {})).toEqual(ok({ checked: SWEEP_PAGE + 1, removed: 0 }));
    }
  });

  it('starts over after a run whose read of the rows failed, and deletes nothing', async () => {
    let failing = false;
    const { sweep, files } = sweepOver(perRun + 600, () => failing);
    const checked = async () => {
      const result = await sweep.execute(system, {});
      if (!result.ok) throw new Error(result.error.code);
      return result.value.checked;
    };

    expect(await checked()).toBe(perRun);
    // The run stops at its first page and forgets where it was.
    failing = true;
    expect(await checked()).toBe(SWEEP_PAGE);
    failing = false;
    expect(await checked()).toBe(perRun);
    expect(files.delete).not.toHaveBeenCalled();
  });
});
