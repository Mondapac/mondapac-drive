import { getTranslations } from 'next-intl/server';
import { rowName } from './row-name.ts';

export type CourierPage = 'fleet' | 'payouts' | 'couriers';

/**
 * The same courier's other pages: fleet profile, payouts and the delivery they are on. Each link
 * shows only for the key that page needs and when its id is known; the page itself checks again.
 * `accountId` is the identity account id, `fleetId` the fleet courier id (31b).
 */
export async function CourierLinks({
  accountId,
  fleetId,
  activeDeliveryId = null,
  keys,
  current,
  row,
}: {
  readonly accountId: string;
  readonly fleetId: string | null;
  readonly activeDeliveryId?: string | null;
  readonly keys: ReadonlySet<string>;
  readonly current: CourierPage;
  /**
   * In a table row: the courier's name. The links then name the row ("Payouts: Noor Haddad")
   * and are a plain list, not one more navigation landmark per row.
   */
  readonly row?: string;
}) {
  const root = await getTranslations();
  const t = await getTranslations('courier-links');
  const links: { readonly id: string; readonly href: string; readonly label: string }[] = [];
  if (current !== 'fleet' && fleetId !== null && keys.has('fleet.courier.view')) {
    links.push({ id: 'fleet', href: `/fleet/couriers/${fleetId}`, label: t('fleet') });
  }
  if (current !== 'payouts' && keys.has('payouts.ledger.view')) {
    links.push({ id: 'payouts', href: `/payouts/couriers/${accountId}`, label: t('payouts') });
  }
  if (activeDeliveryId !== null && keys.has('delivery.delivery.view')) {
    links.push({
      id: 'delivery',
      href: `/deliveries/${activeDeliveryId}`,
      label: t('delivery'),
    });
  }
  if (links.length === 0) return null;
  const list = (
    <ul className="flex flex-wrap gap-x-4">
      {links.map((link) => (
        <li key={link.id}>
          <a
            className="inline-flex min-h-12 items-center text-sm font-medium text-link underline"
            href={link.href}
            aria-label={row === undefined ? undefined : rowName(root, link.label, row)}
          >
            {link.label}
          </a>
        </li>
      ))}
    </ul>
  );
  return row === undefined ? <nav aria-label={t('label')}>{list}</nav> : list;
}
