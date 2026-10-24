import { fireEvent, screen } from '@testing-library/react-native';
import * as Camera from 'expo-camera';
import { ImageManipulator } from 'expo-image-manipulator';
import { Linking } from 'react-native';
import { JobScreen } from '../src/screens/JobScreen';
import { MARKETS } from './markets';
import { acceptNextOffer, createHarness, renderWith } from './render';

const press = (name: string) => fireEvent.press(screen.getByRole('button', { name }));
const typeInto = (label: string, value: string) =>
  fireEvent.changeText(screen.getByLabelText(label), value);
const TEMPERATURE = 'Box temperature (°C)';
const { __takePictureAsync: takePictureAsync } = Camera as unknown as {
  __takePictureAsync: jest.Mock;
};

describe.each(MARKETS)('active job in $marketId', (settings) => {
  const max = settings.coldChain.chilled.maxCelsius;

  /** The mock's first offer is a chilled parcel. */
  async function openJob() {
    const harness = await createHarness({ settings });
    const deliveryId = await acceptNextOffer(harness);
    const onDone = jest.fn();
    await renderWith(harness, <JobScreen deliveryId={deliveryId} onDone={onDone} />);
    await screen.findByText('Head to pickup');
    return { harness, deliveryId, onDone };
  }

  async function reachDropoff() {
    const opened = await openJob();
    await press('I have arrived at pickup');
    await screen.findByText('At pickup');
    await typeInto(TEMPERATURE, String(max));
    await press('Picked up');
    await screen.findByText('Head to drop-off');
    await press('I have arrived at drop-off');
    await screen.findByText('At drop-off');
    return opened;
  }

  it('runs pickup to drop-off with cold-chain readings and the customer PIN', async () => {
    const { harness, onDone } = await openJob();
    await press('I have arrived at pickup');
    await screen.findByText('At pickup');

    expect(screen.getByRole('button', { name: 'Picked up' })).toBeDisabled();
    await typeInto(TEMPERATURE, String(max - 1));
    await press('Picked up');
    await screen.findByText('Head to drop-off');

    await press('I have arrived at drop-off');
    await screen.findByText('At drop-off');
    await typeInto(TEMPERATURE, String(max));
    expect(screen.getByRole('button', { name: 'Complete delivery' })).toBeDisabled();
    await typeInto('PIN from the customer', harness.mock.inspect.pin);
    await press('Complete delivery');
    await screen.findByText('Delivered');

    const events = harness.mock.inspect.events().map((entry) => entry.event);
    expect(events).toEqual([
      { type: 'arrived_at_pickup' },
      { type: 'picked_up', temperatureCelsius: max - 1 },
      { type: 'arrived_at_dropoff' },
      {
        type: 'delivered',
        temperatureCelsius: max,
        proof: { kind: 'pin', pin: harness.mock.inspect.pin },
      },
    ]);
    expect((await harness.api.status()).activeDeliveryId).toBeNull();

    await press('Back to home');
    expect(onDone).toHaveBeenCalled();
  });

  it('warns above the Market limit at pickup and keeps the goods from being picked up', async () => {
    const { harness } = await openJob();
    await press('I have arrived at pickup');
    await screen.findByText('At pickup');

    await typeInto(TEMPERATURE, String(max + 1));
    expect(
      screen.getByText(`${max + 1} °C is above the ${max} °C limit. Do not hand over the goods.`),
    ).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Picked up' })).toBeDisabled();

    const openURL = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined);
    await press('Call support');
    expect(openURL).toHaveBeenCalledWith(`tel:${settings.supportPhone}`);
    expect(harness.mock.inspect.events().map((entry) => entry.event.type)).toEqual([
      'arrived_at_pickup',
    ]);
  });

  it('turns a breach at drop-off into a failed delivery with the cold-chain reason', async () => {
    const { harness } = await reachDropoff();
    await typeInto(TEMPERATURE, String(max + 2));
    expect(screen.queryByText('Proof of delivery')).toBeNull();
    expect(screen.getByRole('button', { name: 'Complete delivery' })).toBeDisabled();

    await press("Can't deliver");
    await press('Report failed delivery');
    await screen.findByText('Delivery failed');
    expect(harness.mock.inspect.events().at(-1)?.event).toEqual({
      type: 'delivery_failed',
      reason: 'cold_chain_breach',
      details: '',
    });
  });

  it('shows the refusal when the PIN does not match', async () => {
    await reachDropoff();
    await typeInto(TEMPERATURE, String(max));
    await typeInto('PIN from the customer', '9999');
    await press('Complete delivery');
    await screen.findByText('The PIN does not match. Ask the customer again.');
    expect(screen.getByText('At drop-off')).toBeOnTheScreen();
  });

  it('uploads a compressed photo as proof', async () => {
    const { harness, deliveryId } = await reachDropoff();
    const upload = jest.spyOn(harness.api, 'uploadProofPhoto');
    await typeInto(TEMPERATURE, String(max));
    await press('Photo');
    await press('Take photo');
    await screen.findByText('Photo ready to upload.');
    await press('Complete delivery');
    await screen.findByText('Delivered');
    expect(harness.mock.inspect.events().at(-1)?.event).toEqual({
      type: 'delivered',
      temperatureCelsius: max,
      proof: { kind: 'photo', photoRef: `mock/proof/${deliveryId}.jpg` },
    });
    // No EXIF from the camera, and the upload is always the re-encoded copy.
    expect(takePictureAsync).toHaveBeenCalledWith(expect.objectContaining({ exif: false }));
    const manipulate = jest.spyOn(ImageManipulator, 'manipulate');
    expect(manipulate).toHaveBeenCalledWith('file:///camera.jpg');
    expect(upload).toHaveBeenCalledWith(deliveryId, {
      uri: 'file:///compressed.jpg',
      mimeType: 'image/jpeg',
    });
  });
});

it('opens the device map app at the next stop', async () => {
  const harness = await createHarness();
  const deliveryId = await acceptNextOffer(harness);
  await renderWith(harness, <JobScreen deliveryId={deliveryId} onDone={jest.fn()} />);
  await screen.findByText('Head to pickup');
  const openURL = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined);
  await press('Navigate');
  const job = await harness.api.job(deliveryId);
  expect(openURL).toHaveBeenCalledWith(expect.stringContaining(`${job.pickup.point!.lat},`));
});
