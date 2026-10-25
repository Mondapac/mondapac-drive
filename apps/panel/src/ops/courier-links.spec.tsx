// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { createTranslator } from 'next-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';
import { CourierLinks } from './courier-links.tsx';

vi.mock('next-intl/server', () => ({
  getTranslations: (namespace?: 'courier-links') =>
    Promise.resolve(createTranslator({ locale: 'en-AU', messages, namespace })),
}));

const ACCOUNT = '0190a000-0000-7000-8000-000000000301';
const FLEET = '0190a000-0000-7000-8000-000000000401';
const DELIVERY = '0190a000-0000-7000-8000-000000000101';
const ALL = new Set(['fleet.courier.view', 'payouts.ledger.view', 'delivery.delivery.view']);

async function mount(props: Partial<Parameters<typeof CourierLinks>[0]> = {}) {
  const element = await CourierLinks({
    accountId: ACCOUNT,
    fleetId: FLEET,
    keys: ALL,
    current: 'couriers',
    ...props,
  });
  render(<>{element}</>);
}

describe('CourierLinks', () => {
  afterEach(cleanup);

  it('links the same courier across fleet, payouts and the current delivery', async () => {
    await mount({ activeDeliveryId: DELIVERY });
    expect(screen.getByRole('navigation', { name: "This courier's other pages" })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Fleet profile' }).getAttribute('href')).toBe(
      `/fleet/couriers/${FLEET}`,
    );
    expect(screen.getByRole('link', { name: 'Payouts' }).getAttribute('href')).toBe(
      `/payouts/couriers/${ACCOUNT}`,
    );
    expect(screen.getByRole('link', { name: 'Current delivery' }).getAttribute('href')).toBe(
      `/deliveries/${DELIVERY}`,
    );
  });

  it('leaves out the page it is on, an unknown fleet id and pages the role lacks', async () => {
    await mount({ current: 'payouts', fleetId: null, keys: new Set(['payouts.ledger.view']) });
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('names the row in a table and adds no landmark per row', async () => {
    await mount({ row: 'Noor Haddad' });
    expect(screen.queryByRole('navigation')).toBeNull();
    expect(screen.getByRole('link', { name: 'Payouts: Noor Haddad' })).toBeTruthy();
  });
});
