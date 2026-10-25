import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { Linking } from 'react-native';
import { MOCK_REVIEW_MS } from '../src/api/mock/mock-client';
import type { OnboardingRules } from '../src/api/schemas';
import { documentLabel } from '../src/screens/onboarding/labels';
import { OnboardingScreen } from '../src/screens/onboarding/OnboardingScreen';
import { ONBOARDING_MARKETS } from './onboarding-markets';
import { createHarness, renderWith, type Harness } from './render';

// The phone's file picker: each test says what the courier picks.
jest.mock('expo-document-picker', () => ({ getDocumentAsync: jest.fn() }));

const picker = jest.requireMock<{ getDocumentAsync: jest.Mock }>('expo-document-picker');
const deviceFiles = jest.requireMock<{ __files: Set<string> }>('expo-file-system').__files;

let picked = 0;
/** The next pick is a PDF of `size` bytes, copied into the picker's cache as on a phone. */
function pickPdf(size = 200_000) {
  picked += 1;
  const uri = `file:///cache/DocumentPicker/doc-${picked}.pdf`;
  deviceFiles.add(uri);
  picker.getDocumentAsync.mockResolvedValueOnce({
    canceled: false,
    assets: [{ uri, name: `scan-${picked}.pdf`, mimeType: 'application/pdf', size }],
  });
  return uri;
}

const press = async (name: string | RegExp) =>
  fireEvent.press(await screen.findByRole('button', { name }));
const choose = async (name: string) => fireEvent.press(await screen.findByRole('radio', { name }));

async function renderOnboarding(harness: Harness) {
  const onReady = jest.fn();
  await renderWith(harness, <OnboardingScreen onReady={onReady} />);
  return onReady;
}

function motorVehicle(rules: OnboardingRules) {
  return rules.vehicleClasses.find((vehicle) => vehicle.type !== 'bicycle')!;
}

const VEHICLE_LABELS = {
  bicycle: 'Bicycle',
  motorbike: 'Motorbike or scooter',
  car: 'Car',
  van: 'Van',
} as const;

let openUrl: jest.SpyInstance;
beforeEach(() => {
  picker.getDocumentAsync.mockReset();
  openUrl = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined);
});

describe.each(ONBOARDING_MARKETS)('onboarding in $settings.marketId', ({ settings, rules }) => {
  it('takes a new contractor from profile to approval and deletes each uploaded file', async () => {
    const harness = await createHarness({ settings, onboardingRules: rules, newCourier: true });
    const onReady = await renderOnboarding(harness);

    // 1. Profile
    await screen.findByText('Step 1 of 4');
    await choose('Independent contractor');
    if (rules.serviceAreas.length > 1) await choose(rules.serviceAreas[0]!.code);
    await choose('Yes');
    await press('Continue');

    // 2. Vehicle, with the rate card's capacity
    await screen.findByText('Step 2 of 4');
    const vehicleClass = motorVehicle(rules);
    await choose(VEHICLE_LABELS[vehicleClass.type]);
    expect(
      screen.getByText(
        `Carries up to ${vehicleClass.maxWeightGrams / 1000} kg and ${vehicleClass.maxVolumeLitres} L. An operator can change this later.`,
      ),
    ).toBeOnTheScreen();
    await fireEvent.changeText(screen.getByLabelText('Number plate'), 'abc 123');
    await press('Add vehicle');

    // 3. Each document the Market asks of a cold-chain contractor with this vehicle
    await screen.findByText('Step 3 of 4');
    const profile = await harness.api.profile();
    expect(profile!.vehicles[0]).toMatchObject({
      plate: 'ABC123',
      maxWeightGrams: vehicleClass.maxWeightGrams,
    });
    const files: string[] = [];
    for (;;) {
      const next = screen.queryAllByRole('button', { name: /^Add: / })[0];
      if (!next) break;
      await fireEvent.press(next);
      const title = await screen.findByText(/^Add .+/);
      const type = rules.documents.find(
        (document) => title.props.children === `Add ${documentLabel(document.type)}`,
      )!;
      files.push(pickPdf());
      await press('Choose a file');
      await screen.findByText(/is ready to upload\.$/);
      if (type.expires) {
        await fireEvent.changeText(screen.getByLabelText('Expiry date (YYYY-MM-DD)'), '2030-01-31');
      }
      await press('Upload');
      await screen.findByText(/Step [34] of 4/);
    }
    const required = rules.documents.filter(
      (document) => !document.vehicleTypes || document.vehicleTypes.includes(vehicleClass.type),
    );
    expect(
      harness.mock.inspect
        .uploads()
        .map((upload) => upload.type)
        .sort(),
    ).toEqual(required.map((document) => document.type).sort());
    for (const uri of files) expect(deviceFiles.has(uri)).toBe(false);

    // 4. Waiting, with the payout set-up in the system browser
    await screen.findByText('Step 4 of 4');
    await press('Set up payouts');
    await waitFor(() =>
      expect(openUrl).toHaveBeenCalledWith(
        'https://connect.example.test/onboarding/mock-courier-1',
      ),
    );
    expect(onReady).not.toHaveBeenCalled();

    // The operator approves; the courier checks again and goes on.
    await act(() => harness.clock.advance(MOCK_REVIEW_MS));
    await press('Check again');
    await waitFor(() => expect(onReady).toHaveBeenCalled());
  });

  it('resumes at the documents step after a restart', async () => {
    const harness = await createHarness({ settings, onboardingRules: rules, newCourier: true });
    await harness.api.applyAsCourier({
      employmentType: 'employee',
      serviceAreaCode: rules.serviceAreas[0]!.code,
      coldChainCapable: false,
    });
    await harness.api.addVehicle({
      type: motorVehicle(rules).type,
      plate: 'XYZ9',
      coldBox: 'none',
    });
    await renderOnboarding(harness);
    await screen.findByText('Step 3 of 4');
    expect(screen.queryByRole('button', { name: 'Set up payouts' })).toBeNull();
  });
});

it('sends an approved courier straight on', async () => {
  const harness = await createHarness();
  const onReady = await renderOnboarding(harness);
  await waitFor(() => expect(onReady).toHaveBeenCalled());
});

it('goes on for an approved courier when the API sends no onboarding rules yet', async () => {
  const harness = await createHarness({ onboardingRules: null });
  const onReady = await renderOnboarding(harness);
  await waitFor(() => expect(onReady).toHaveBeenCalled());
});

it('sends a new courier to support when the API sends no onboarding rules yet', async () => {
  const harness = await createHarness({ onboardingRules: null, newCourier: true });
  await renderOnboarding(harness);
  await screen.findByText(/Sign-up is not open in the app yet/);
  expect(screen.getByRole('button', { name: 'Call support' })).toBeOnTheScreen();
});

describe('documents', () => {
  const { settings, rules } = ONBOARDING_MARKETS[0]!;

  async function atDocuments() {
    const harness = await createHarness({ settings, onboardingRules: rules, newCourier: true });
    await harness.api.applyAsCourier({
      employmentType: 'employee',
      serviceAreaCode: rules.serviceAreas[0]!.code,
      coldChainCapable: false,
    });
    await harness.api.addVehicle({ type: 'bicycle', coldBox: 'none' });
    await renderOnboarding(harness);
    await screen.findByText('Step 3 of 4');
    return harness;
  }

  it('takes a photo with the camera, re-encodes it and deletes both copies', async () => {
    const harness = await atDocuments();
    await press(/^Add: /);
    await press('Take a photo');
    await press('Capture');
    await screen.findByText('document.jpg is ready to upload.');
    expect(deviceFiles.has('file:///camera.jpg')).toBe(false);
    await fireEvent.changeText(screen.getByLabelText('Expiry date (YYYY-MM-DD)'), '2030-01-31');
    await press('Upload');
    await screen.findByText('Step 4 of 4');
    expect(harness.mock.inspect.uploads()[0]).toMatchObject({ mimeType: 'image/jpeg' });
    expect(deviceFiles.has('file:///compressed.jpg')).toBe(false);
  });

  it('refuses a file over 10 MB and a past expiry date before uploading', async () => {
    const harness = await atDocuments();
    await press(/^Add: /);
    const big = pickPdf(11 * 1024 * 1024);
    await press('Choose a file');
    await screen.findByText(/larger than 10 MB/);
    expect(deviceFiles.has(big)).toBe(false);

    pickPdf();
    await press('Choose a file');
    await screen.findByText(/is ready to upload\.$/);
    await fireEvent.changeText(screen.getByLabelText('Expiry date (YYYY-MM-DD)'), '2020-01-01');
    await press('Upload');
    await screen.findByText('This document has expired. Upload a current one.');
    expect(harness.mock.inspect.uploads()).toHaveLength(0);
  });

  it('deletes a chosen file when the courier cancels', async () => {
    await atDocuments();
    await press(/^Add: /);
    const uri = pickPdf();
    await press('Choose a file');
    await screen.findByText(/is ready to upload\.$/);
    await press('Cancel');
    await screen.findByRole('button', { name: /^Add: / });
    expect(deviceFiles.has(uri)).toBe(false);
  });

  it('shows why an operator rejected a document and asks for it again', async () => {
    const harness = await atDocuments();
    await press(/^Add: /);
    pickPdf();
    await press('Choose a file');
    await screen.findByText(/is ready to upload\.$/);
    await fireEvent.changeText(screen.getByLabelText('Expiry date (YYYY-MM-DD)'), '2030-01-31');
    await press('Upload');
    await screen.findByText('Step 4 of 4');
    const [document] = (await harness.api.profile())!.documents;
    harness.mock.inspect.rejectDocument(document!.id, 'illegible');
    await press('Check again');
    await screen.findByText('Not accepted: hard to read');
    expect(screen.getByRole('button', { name: /^Upload again: / })).toBeOnTheScreen();
  });
});
