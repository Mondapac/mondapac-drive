import { fireEvent, screen } from '@testing-library/react-native';
import { ApiError } from '../src/api/client';
import { EarningsScreen } from '../src/screens/EarningsScreen';
import { MARKETS } from './markets';
import { acceptNextOffer, createHarness, renderWith } from './render';

describe.each(MARKETS)('earnings in $marketId', (settings) => {
  const money = (minor: number) => {
    const format = new Intl.NumberFormat(settings.locale, {
      style: 'currency',
      currency: settings.currency,
    });
    const digits = format.resolvedOptions().maximumFractionDigits ?? 2;
    return format.format(minor / 10 ** digits);
  };

  it('shows an empty ledger before the first delivery', async () => {
    const harness = await createHarness({ settings });
    await renderWith(harness, <EarningsScreen onBack={jest.fn()} />);
    await screen.findByText('No earnings yet. Completed deliveries show here.');
    expect(screen.getByText('0 deliveries today')).toBeOnTheScreen();
    expect(screen.getAllByText(money(0)).length).toBeGreaterThanOrEqual(3);
  });

  it('shows today, the week, the balance and the delivery in the Market currency', async () => {
    const harness = await createHarness({ settings });
    const deliveryId = await acceptNextOffer(harness);
    await harness.api.recordEvent(deliveryId, { type: 'arrived_at_pickup' });
    await harness.api.recordEvent(deliveryId, { type: 'picked_up', temperatureCelsius: 3 });
    await harness.api.recordEvent(deliveryId, { type: 'arrived_at_dropoff' });
    await harness.api.recordEvent(deliveryId, {
      type: 'delivered',
      proof: { kind: 'pin', pin: harness.mock.inspect.pin },
      temperatureCelsius: 3,
    });

    await renderWith(harness, <EarningsScreen onBack={jest.fn()} />);
    await screen.findByText('Delivery');
    expect(screen.getByText('1 deliveries today')).toBeOnTheScreen();
    // Today, this week, what is owed and the entry itself: 950 minor units each.
    expect(screen.getAllByText(money(950))).toHaveLength(4);
    expect(screen.queryByText(/tax/)).toBeNull();
  });
});

it('shows the tax on the balance, signed entries and an unknown kind as "Other"', async () => {
  const harness = await createHarness();
  const balance = jest.spyOn(harness.api, 'balance').mockResolvedValue({
    balance: {
      amount: { amount: '1000', currency: 'AUD' },
      tax: { amount: '100', currency: 'AUD' },
      total: { amount: '1100', currency: 'AUD' },
    },
    entries: [
      {
        id: 'e-2',
        kind: 'payout',
        amount: { amount: '-500', currency: 'AUD' },
        tax: { amount: '-50', currency: 'AUD' },
        occurredAt: '2026-10-24T09:00:00Z',
      },
      {
        id: 'e-1',
        kind: 'bonus-from-a-newer-api',
        amount: { amount: '200', currency: 'AUD' },
        tax: { amount: '0', currency: 'AUD' },
        occurredAt: '2026-10-23T09:00:00Z',
      },
    ],
  });
  await renderWith(harness, <EarningsScreen onBack={jest.fn()} />);
  await screen.findByText('Paid to your account');
  expect(screen.getByText('$11.00')).toBeOnTheScreen();
  expect(screen.getByText('Includes $1.00 tax')).toBeOnTheScreen();
  expect(screen.getByText('-$5.50')).toBeOnTheScreen();
  expect(screen.getByText('Other')).toBeOnTheScreen();
  expect(balance).toHaveBeenCalledWith(20);
});

it('shows a refusal and loads again on refresh', async () => {
  const harness = await createHarness();
  const balance = jest
    .spyOn(harness.api, 'balance')
    .mockRejectedValue(new ApiError(0, 'network.unavailable'));
  await renderWith(harness, <EarningsScreen onBack={jest.fn()} />);
  // The query client tries once more (after a second) before it shows the refusal.
  await screen.findByText(
    'No connection. Check your mobile data and try again.',
    {},
    { timeout: 5_000 },
  );
  balance.mockRestore();
  await fireEvent.press(screen.getByRole('button', { name: 'Refresh' }));
  await screen.findByText('No earnings yet. Completed deliveries show here.');
});
