import 'server-only';
import { UUID } from '../ops/types.ts';
import { serverGet } from '../server/server-fetch.ts';
import type { CourierListPage } from './types.ts';

/** Pages of the fleet list read at most for one screen (100 couriers each). */
const MAX_FLEET_PAGES = 20;

/**
 * The fleet id of each courier by identity account id, so payouts and courier-account rows can
 * link to the fleet page. Read only with `fleet.courier.view`; an empty map when the session
 * lacks it or the first read fails, and those rows then show no fleet link.
 */
export async function fleetIdsByAccount(
  keys: ReadonlySet<string>,
): Promise<ReadonlyMap<string, string>> {
  const ids = new Map<string, string>();
  if (!keys.has('fleet.courier.view')) return ids;
  let after: string | null = null;
  for (let page = 0; page < MAX_FLEET_PAGES; page += 1) {
    const query: string = after === null ? '' : `&after=${after}`;
    const answer = await serverGet<CourierListPage>(`fleet/admin/couriers?limit=100${query}`);
    if (answer.kind !== 'ok') break;
    for (const courier of answer.body.items) ids.set(courier.accountId, courier.id);
    after = answer.body.next;
    if (after === null || !UUID.test(after)) break;
  }
  return ids;
}
