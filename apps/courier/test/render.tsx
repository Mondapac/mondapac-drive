import { fireEvent, render, screen } from '@testing-library/react-native';
import type { ReactElement } from 'react';
import { createMockCourierApi } from '../src/api/mock/mock-client';
import type { CourierSession, CourierSettings, OnboardingRules } from '../src/api/schemas';
import type { LocationAccess } from '../src/location/tracking';
import { fakeClock } from '../src/platform/clock/clock';
import { AppProviders, createQueryClient, type SessionStorage } from '../src/providers';

export const START = Date.parse('2026-10-24T09:00:00Z');

/** The mock backend, a fake clock and fake tracking, signed in. */
export async function createHarness(
  options: {
    settings?: CourierSettings;
    access?: LocationAccess;
    onboardingRules?: OnboardingRules | null;
    newCourier?: boolean;
  } = {},
) {
  const clock = fakeClock(START);
  const mock = createMockCourierApi({
    clock,
    ...(options.settings ? { settings: options.settings } : {}),
    ...(options.onboardingRules === undefined ? {} : { onboardingRules: options.onboardingRules }),
    ...(options.newCourier ? { newCourier: true } : {}),
  });
  const session = await mock.api.signIn({ email: 'courier@example.test', password: 'secret-1' });
  let stored: CourierSession | null = session;
  const storage: SessionStorage = {
    load: () => Promise.resolve(stored),
    save: (value) => {
      stored = value;
      return Promise.resolve();
    },
    clear: () => {
      stored = null;
      return Promise.resolve();
    },
  };
  const tracking = {
    access: jest.fn(() => Promise.resolve<LocationAccess>(options.access ?? 'granted')),
    start: jest.fn(() => Promise.resolve()),
    stop: jest.fn(() => Promise.resolve()),
  };
  return { clock, mock, api: mock.api, session, storage, tracking, stored: () => stored };
}
export type Harness = Awaited<ReturnType<typeof createHarness>>;

/** Renders a screen inside the app's providers. */
export function renderWith(harness: Harness, ui: ReactElement) {
  const queryClient = createQueryClient();
  // No garbage-collection timers, so that nothing outlives a test.
  const defaults = queryClient.getDefaultOptions();
  queryClient.setDefaultOptions({
    queries: { ...defaults.queries, gcTime: Infinity },
    mutations: { ...defaults.mutations, gcTime: Infinity },
  });
  return render(
    <AppProviders
      api={harness.api}
      clock={harness.clock}
      queryClient={queryClient}
      storage={harness.storage}
      tracking={harness.tracking}
    >
      {ui}
    </AppProviders>,
  );
}

/** Goes online on the mock and accepts its next offer; returns the delivery id. */
export async function acceptNextOffer(harness: Harness): Promise<string> {
  await harness.api.setShift('online');
  const offer = await harness.api.currentOffer();
  return (await harness.api.acceptOffer(offer!.id)).deliveryId;
}

interface MarketConfig {
  readonly code: string;
  readonly defaultLocale: string;
  readonly defaultCurrency: string;
  readonly delivery: { readonly coldChain: CourierSettings['coldChain'] };
}

/**
 * What the API would send a courier of a Market, built from the repository's Market config
 * (config/markets/AU.json and the synthetic test/fixtures/markets/ZZ.json).
 */
export function settingsOf(market: MarketConfig): CourierSettings {
  return {
    marketId: market.code,
    locale: market.defaultLocale,
    currency: market.defaultCurrency,
    distanceUnit: 'km',
    supportPhone: '+00 0000',
    offerAcceptSeconds: 30,
    coldChain: market.delivery.coldChain,
  };
}

/**
 * Confirms a slide-to-confirm control the way a screen reader does (its activate action); a tap
 * alone does not confirm it.
 */
export function slide(name: string) {
  return fireEvent(screen.getByRole('button', { name }), 'accessibilityAction', {
    nativeEvent: { actionName: 'activate' },
  });
}
