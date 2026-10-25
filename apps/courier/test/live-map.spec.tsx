import { fireEvent, screen } from '@testing-library/react-native';
import { mapsAvailable } from '../src/map/map-support';
import { HomeScreen } from '../src/screens/HomeScreen';
import { JobScreen } from '../src/screens/JobScreen';
import { MARKETS } from './markets';
import { acceptNextOffer, createHarness, renderWith } from './render';

describe('where the build has a map', () => {
  it('always on iOS, on Android only with a Maps key, never on the web', () => {
    expect(mapsAvailable('ios', undefined)).toBe(true);
    expect(mapsAvailable('android', { androidMaps: true })).toBe(true);
    expect(mapsAvailable('android', { androidMaps: false })).toBe(false);
    expect(mapsAvailable('android', undefined)).toBe(false);
    expect(mapsAvailable('web', { androidMaps: true })).toBe(false);
  });
});

describe.each(MARKETS)('the live map in $marketId', (settings) => {
  it('pins the offer by area only, before the courier accepts', async () => {
    const harness = await createHarness({ settings });
    await renderWith(
      harness,
      <HomeScreen onOpenJob={jest.fn()} onOpenEarnings={jest.fn()} onNeedLocation={jest.fn()} />,
    );
    await screen.findByText('You are offline');
    expect(screen.getByTestId('live-map')).toBeOnTheScreen();
    expect(screen.queryAllByTestId('map-pin')).toHaveLength(0);

    await fireEvent.press(screen.getByRole('button', { name: 'Go online' }));
    await screen.findByText('New delivery offer');
    expect(screen.getByLabelText('Pickup: Woolloongabba 4102')).toBeOnTheScreen();
    expect(screen.getByLabelText('Drop-off: Coorparoo 4151')).toBeOnTheScreen();
    expect(screen.queryByLabelText(/Logan Rd|Sample St/)).toBeNull();
  });

  it('pins the current stop of the job', async () => {
    const harness = await createHarness({ settings });
    const deliveryId = await acceptNextOffer(harness);
    await renderWith(harness, <JobScreen deliveryId={deliveryId} onDone={jest.fn()} />);
    await screen.findByText('Head to pickup');
    const job = await harness.api.job(deliveryId);
    // The mock geocodes every stop.
    expect(screen.getAllByTestId('map-pin')).toHaveLength(1);
    expect(screen.getByLabelText(`Pickup: ${job.pickup.address}`)).toBeOnTheScreen();
  });
});
