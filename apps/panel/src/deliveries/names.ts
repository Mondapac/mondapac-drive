import 'server-only';
import { serverGet } from '../server/server-fetch.ts';
import { UUID, type CourierRow, type CourierPage, type Merchant } from '../ops/types.ts';

/** The first 8 characters of an id, for a row whose name the session may not read. */
export const shortId = (id: string): string => id.slice(0, 8);

/** Pages of the courier list read at most for one screen (100 rows each). */
const MAX_COURIER_PAGES = 20;

/**
 * Every courier row, page by page (Hassan, WP3 review: a first page alone hid couriers from the
 * dispatch picker). Null when the first read fails; a later failure keeps the rows read so far.
 */
async function allCouriers(): Promise<readonly CourierRow[] | null> {
  const rows: CourierRow[] = [];
  let after: string | null = null;
  for (let page = 0; page < MAX_COURIER_PAGES; page += 1) {
    const query: string = after === null ? '' : `&after=${after}`;
    const answer = await serverGet<CourierPage>(`identity/admin/couriers?limit=100${query}`);
    if (answer.kind !== 'ok') return page === 0 ? null : rows;
    rows.push(...answer.body.items);
    after = answer.body.next;
    if (after === null || !UUID.test(after)) break;
  }
  return rows;
}

/**
 * Names for the ids a delivery carries, read only with the keys that allow it: merchants with
 * `identity.merchant.view`, couriers (every account, paged) with
 * `identity.courier-account.view`. A missing read leaves the map empty; rows then show short ids.
 */
export async function namesFor(keys: ReadonlySet<string>): Promise<{
  readonly merchants: ReadonlyMap<string, string>;
  readonly couriers: ReadonlyMap<string, string>;
  readonly activeCouriers: readonly { readonly accountId: string; readonly name: string }[];
}> {
  const [merchants, couriers] = await Promise.all([
    keys.has('identity.merchant.view')
      ? serverGet<{ readonly items: readonly Merchant[] }>('identity/admin/merchants')
      : Promise.resolve(null),
    keys.has('identity.courier-account.view') ? allCouriers() : Promise.resolve(null),
  ]);
  const merchantNames = new Map<string, string>();
  if (merchants?.kind === 'ok') {
    for (const row of merchants.body.items) merchantNames.set(row.merchantId, row.name);
  }
  const courierNames = new Map<string, string>();
  const activeCouriers: { accountId: string; name: string }[] = [];
  if (couriers !== null) {
    for (const row of couriers) {
      if (row.type !== 'account') continue;
      const name = row.displayName ?? row.email;
      courierNames.set(row.accountId, name);
      if (row.status === 'active') activeCouriers.push({ accountId: row.accountId, name });
    }
  }
  return { merchants: merchantNames, couriers: courierNames, activeCouriers };
}
