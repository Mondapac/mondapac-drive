import { Temporal } from '@mondapac-drive/shared-kernel';
import { expectSystemOnly, openGate } from '../../../../../test/support/system-only-denial';
import { TEST_MARKETS } from '../../../../../test/support/test-config';
import type { PayoutsDependencies } from '../dependencies';
import { RecordDeliveryEarning } from './record-delivery-earning.use-case';
import { RecordTip } from './record-tip.use-case';
import { ReverseDeliveryEarning } from './reverse-delivery-earning.use-case';
import { RunPayouts } from './run-payouts.use-case';

// The gate in front of the payouts use cases that only the system actor runs (the payout job
// and the event subscribers): every other caller is refused before any port is touched. The
// rest of the flow, behind the gate, runs on the database (test/db/payouts-flow.db-spec.ts).

/** Ports that fail the test if a refused call reaches them. */
const untouchable = new Proxy({} as PayoutsDependencies, {
  get(_target, port) {
    throw new Error(`port ${String(port)} reached by a refused caller`);
  },
});

describe.each(TEST_MARKETS)('payouts system use cases in %s', (code) => {
  const gate = openGate();

  it('refuse every caller but the system actor', async () => {
    const earn = new RecordDeliveryEarning(gate, untouchable);
    const tip = new RecordTip(gate, untouchable);
    const reverse = new ReverseDeliveryEarning(gate, untouchable);
    const run = new RunPayouts(gate, untouchable);
    const at = Temporal.Instant.from('2026-11-02T00:00:00Z');

    await expectSystemOnly(code, (context) =>
      earn.execute(context, { deliveryId: 'd-1', courierId: 'c-1', deliveredAt: at }),
    );
    await expectSystemOnly(code, (context) =>
      tip.execute(context, {
        deliveryId: 'd-1',
        courierId: 'c-1',
        amount: { amount: 1n, currency: 'AUD' },
        occurredAt: at,
      }),
    );
    await expectSystemOnly(code, (context) => reverse.execute(context, { deliveryId: 'd-1' }));
    await expectSystemOnly(code, (context) => run.execute(context, {}));
  });
});
