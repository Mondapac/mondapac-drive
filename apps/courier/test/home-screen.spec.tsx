import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { ApiError } from '../src/api/client';
import { HomeScreen } from '../src/screens/HomeScreen';
import { MARKETS } from './markets';
import { createHarness, renderWith, slide, type Harness } from './render';

const press = (name: string) => fireEvent.press(screen.getByRole('button', { name }));

async function renderHome(harness: Harness) {
  const handlers = { onOpenJob: jest.fn(), onOpenEarnings: jest.fn(), onNeedLocation: jest.fn() };
  await renderWith(harness, <HomeScreen {...handlers} />);
  return handlers;
}

describe.each(MARKETS)('home in $marketId', (settings) => {
  it('goes online, starts tracking and shows an offer with its pay', async () => {
    const harness = await createHarness({ settings });
    await renderHome(harness);
    await screen.findByText('You are offline');
    await press('Go online');
    await screen.findByText('New delivery offer');
    expect(harness.tracking.start).toHaveBeenCalledTimes(1);
    const offer = await harness.api.currentOffer();
    const pay = new Intl.NumberFormat(settings.locale, {
      style: 'currency',
      currency: settings.currency,
    });
    expect(offer!.earnings!.currency).toBe(settings.currency);
    expect(screen.getByText('Estimated pay')).toBeOnTheScreen();
    expect(screen.getByText(pay.format(settings.currency === 'JPY' ? 950 : 9.5))).toBeOnTheScreen();
    expect(screen.getByText('30 s to respond')).toBeOnTheScreen();
  });

  it('names only the suburb and postcode of each stop before accept', async () => {
    const harness = await createHarness({ settings });
    await renderHome(harness);
    await screen.findByText('You are offline');
    await press('Go online');
    await screen.findByText('New delivery offer');
    expect(screen.getByText('Woolloongabba 4102')).toBeOnTheScreen();
    expect(screen.getByText('Coorparoo 4151')).toBeOnTheScreen();
    expect(screen.getByText('You see the full address once you accept.')).toBeOnTheScreen();
    expect(screen.queryByText(/Logan Rd|Sample St/)).toBeNull();
  });
});

it('says pay is unavailable when the offer has none, and shows the postcode without a suburb', async () => {
  const harness = await createHarness();
  const real = harness.api.currentOffer.bind(harness.api);
  jest.spyOn(harness.api, 'currentOffer').mockImplementation(async () => {
    const offer = await real();
    return offer && { ...offer, earnings: null, dropoff: { ...offer.dropoff, suburb: null } };
  });
  await renderHome(harness);
  await screen.findByText('You are offline');
  await press('Go online');
  await screen.findByText('New delivery offer');
  expect(screen.queryByText('Estimated pay')).toBeNull();
  expect(screen.getByText('Pay unavailable for this offer')).toBeOnTheScreen();
  expect(screen.getByText('4151')).toBeOnTheScreen();
  expect(screen.getByText('Woolloongabba 4102')).toBeOnTheScreen();
});

it('accepts an offer and opens its job', async () => {
  const harness = await createHarness();
  const handlers = await renderHome(harness);
  await screen.findByText('You are offline');
  await press('Go online');
  await screen.findByText('New delivery offer');
  await slide('Accept');
  await waitFor(() => expect(handlers.onOpenJob).toHaveBeenCalledWith('mock-delivery-1'));
  await screen.findByText('Continue active delivery');
});

it('declines an offer', async () => {
  const harness = await createHarness();
  await renderHome(harness);
  await screen.findByText('You are offline');
  await press('Go online');
  await screen.findByText('New delivery offer');
  await press('Decline');
  await waitFor(async () => expect((await harness.api.status()).activeDeliveryId).toBeNull());
});

it('counts down and stops offering an expired offer', async () => {
  jest.useFakeTimers();
  try {
    const harness = await createHarness();
    await renderHome(harness);
    await screen.findByText('You are offline');
    await press('Go online');
    await screen.findByText('30 s to respond');

    await act(() => {
      harness.clock.advance(12_000);
      jest.advanceTimersByTime(1_000);
    });
    expect(screen.getByText('18 s to respond')).toBeOnTheScreen();

    await act(() => {
      harness.clock.advance(18_000);
      jest.advanceTimersByTime(1_000);
    });
    expect(screen.queryByRole('button', { name: 'Accept' })).toBeNull();
    await expect(harness.api.acceptOffer('mock-offer-1')).rejects.toMatchObject({
      code: 'offer.not-found',
    });
  } finally {
    jest.useRealTimers();
  }
});

it('asks for location first when it is not granted', async () => {
  const harness = await createHarness({ access: 'ask' });
  const handlers = await renderHome(harness);
  await screen.findByText('You are offline');
  await press('Go online');
  await waitFor(() => expect(handlers.onNeedLocation).toHaveBeenCalled());
  expect(harness.tracking.start).not.toHaveBeenCalled();
  expect((await harness.api.status()).shift).toBe('offline');
});

it('stops sharing location even when the server refuses to go offline', async () => {
  const harness = await createHarness();
  await renderHome(harness);
  await screen.findByText('You are offline');
  await press('Go online');
  await screen.findByText('You are online');
  jest.spyOn(harness.api, 'setShift').mockRejectedValueOnce(new ApiError(0, 'network.unavailable'));
  await press('Go offline');
  await screen.findByText('No connection. Check your mobile data and try again.');
  expect(harness.tracking.stop).toHaveBeenCalledTimes(1);
});

it('signs out and stops tracking when the server rejects the session', async () => {
  const harness = await createHarness();
  jest.spyOn(harness.api, 'status').mockRejectedValue(new ApiError(401, 'session.invalid'));
  await renderHome(harness);
  await waitFor(() => expect(harness.stored()).toBeNull());
  expect(harness.tracking.stop).toHaveBeenCalled();
});

it('stops tracking when going offline', async () => {
  const harness = await createHarness();
  await renderHome(harness);
  await screen.findByText('You are offline');
  await press('Go online');
  await screen.findByText('You are online');
  await press('Go offline');
  await screen.findByText('You are offline');
  expect(harness.tracking.stop).toHaveBeenCalledTimes(1);
});

it('explains that an open job keeps the courier online', async () => {
  const harness = await createHarness();
  await renderHome(harness);
  await screen.findByText('You are offline');
  await press('Go online');
  await screen.findByText('You are online');
  jest
    .spyOn(harness.api, 'setShift')
    .mockRejectedValueOnce(new ApiError(409, 'fleet.shift.active-delivery'));
  await press('Go offline');
  await screen.findByText('Finish your active delivery before you go offline.');
});
