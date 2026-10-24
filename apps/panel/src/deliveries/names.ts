import 'server-only';
import { serverGet } from '../server/server-fetch.ts';
import type { CourierPage, Merchant } from '../ops/types.ts';

/** The first 8 characters of an id, for a row whose name the session may not read. */
export const shortId = (id: string): string => id.slice(0, 8);

/**
 * Names for the ids a delivery carries, read only with the keys that allow it: merchants with
 * `identity.merchant.view`, couriers (active accounts, first page) with
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
    keys.has('identity.courier-account.view')
      ? serverGet<CourierPage>('identity/admin/couriers?limit=100')
      : Promise.resolve(null),
  ]);
  const merchantNames = new Map<string, string>();
  if (merchants?.kind === 'ok') {
    for (const row of merchants.body.items) merchantNames.set(row.merchantId, row.name);
  }
  const courierNames = new Map<string, string>();
  const activeCouriers: { accountId: string; name: string }[] = [];
  if (couriers?.kind === 'ok') {
    for (const row of couriers.body.items) {
      if (row.type !== 'account') continue;
      const name = row.displayName ?? row.email;
      courierNames.set(row.accountId, name);
      if (row.status === 'active') activeCouriers.push({ accountId: row.accountId, name });
    }
  }
  return { merchants: merchantNames, couriers: courierNames, activeCouriers };
}
