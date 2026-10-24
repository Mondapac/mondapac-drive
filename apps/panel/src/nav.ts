import type { NavConfig } from '@mondapac-drive/ui';

// The operations panel's nav (marketplace panels IA 3.1). Each item shows only to an admin who
// holds one of its keys; the API checks every call again.
export const adminNav: NavConfig = {
  items: [
    { id: 'home', icon: 'home', labelKey: 'nav.home', href: '/' },
    {
      id: 'deliveries',
      icon: 'package',
      labelKey: 'nav.deliveries',
      href: '/deliveries',
      anyOf: ['delivery.delivery.view'],
    },
    {
      id: 'live-map',
      icon: 'map-pin',
      labelKey: 'nav.live-map',
      href: '/live-map',
      anyOf: ['tracking.map.view'],
    },
    {
      id: 'couriers',
      icon: 'users',
      labelKey: 'nav.couriers',
      href: '/couriers',
      anyOf: ['identity.courier-account.view'],
    },
    {
      id: 'payouts',
      icon: 'wallet',
      labelKey: 'nav.payouts',
      href: '/payouts',
      anyOf: ['payouts.ledger.view'],
    },
    {
      id: 'merchants',
      icon: 'store',
      labelKey: 'nav.merchants',
      href: '/merchants',
      anyOf: ['identity.merchant.view'],
    },
    {
      id: 'team',
      icon: 'key',
      labelKey: 'nav.team',
      href: '/team',
      anyOf: ['identity.admin-account.view'],
    },
  ],
};
