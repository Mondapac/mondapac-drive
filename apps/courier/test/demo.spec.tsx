import { render, screen } from '@testing-library/react-native';
import au from '../../../config/markets/AU.json';
import zz from '../../../test/fixtures/markets/ZZ.json';
import { BASE_APPLICATION_ID, resolveRelease } from '../release/release-config';
import fixture from '../src/api/mock/mock-market.json';
import { readEnv } from '../src/platform/env';
import { EarningsScreen } from '../src/screens/EarningsScreen';
import { SignInScreen } from '../src/screens/SignInScreen';
import { DemoRibbon } from '../src/ui/DemoRibbon';
import { MARKETS } from './markets';
import { createHarness, renderWith } from './render';

const marketExists = (code: string) => code === au.code || code === zz.code;
const RELEASE = false;

describe('the demo build', () => {
  it('runs on the sample data in a release build, and only with no API', () => {
    expect(readEnv({ EXPO_PUBLIC_DEMO: '1' }, RELEASE)).toEqual({
      apiMode: 'mock',
      apiUrl: undefined,
      marketId: undefined,
      demo: true,
    });
    expect(() =>
      readEnv({ EXPO_PUBLIC_DEMO: '1', EXPO_PUBLIC_API_URL: 'https://api.example.test' }, RELEASE),
    ).toThrow(/sample data/);
    expect(() => readEnv({ EXPO_PUBLIC_DEMO: 'yes' }, RELEASE)).toThrow(/release build/);
  });

  it('installs beside the other builds under its own identifier and name', () => {
    expect(
      resolveRelease({ APP_VARIANT: 'demo', EXPO_PUBLIC_DEMO: '1' }, '0.1.0', marketExists),
    ).toMatchObject({
      variant: 'demo',
      applicationId: `${BASE_APPLICATION_ID}.demo`,
      nameSuffix: ' (Demo)',
      apiUrl: undefined,
    });
  });

  it('refuses a demo with an API, and the demo switch on any other variant', () => {
    expect(() => resolveRelease({ APP_VARIANT: 'demo' }, '0.1.0', marketExists)).toThrow(
      'EXPO_PUBLIC_DEMO=1',
    );
    expect(() =>
      resolveRelease(
        {
          APP_VARIANT: 'demo',
          EXPO_PUBLIC_DEMO: '1',
          EXPO_PUBLIC_API_URL: 'https://api.example.test',
        },
        '0.1.0',
        marketExists,
      ),
    ).toThrow('sample data');
    for (const variant of ['development', 'preview', 'production']) {
      expect(() =>
        resolveRelease(
          {
            APP_VARIANT: variant,
            EXPO_PUBLIC_DEMO: '1',
            EXPO_PUBLIC_API_URL: 'https://api.example.test',
            EXPO_PUBLIC_MARKET_ID: zz.code,
          },
          '0.1.0',
          marketExists,
        ),
      ).toThrow('demo variant');
    }
  });

  it('says it is a demo on every screen', async () => {
    await render(<DemoRibbon demo />);
    expect(screen.getByText('Demo · sample data, nothing is sent')).toBeOnTheScreen();
  });

  it('shows no demo strip in other builds', async () => {
    await render(<DemoRibbon demo={false} />);
    expect(screen.queryByText(/Demo/)).toBeNull();
  });

  it('tells people how to sign in to the demo', async () => {
    const harness = await createHarness();
    await renderWith(harness, <SignInScreen demo />);
    expect(
      await screen.findByText(new RegExp(`delivery PIN is ${fixture.deliveryPin}`)),
    ).toBeOnTheScreen();
  });

  it('gives no demo sign-in hint in other builds', async () => {
    const harness = await createHarness();
    await renderWith(harness, <SignInScreen />);
    await screen.findByRole('button', { name: 'Sign in' });
    expect(screen.queryByText(/This is a demo/)).toBeNull();
  });
});

describe.each(MARKETS)('demo earnings in $marketId', (settings) => {
  const money = (minor: number) => {
    const format = new Intl.NumberFormat(settings.locale, {
      style: 'currency',
      currency: settings.currency,
    });
    const digits = format.resolvedOptions().maximumFractionDigits ?? 2;
    return format.format(minor / 10 ** digits);
  };
  const minor = (kinds: (kind: string) => boolean) =>
    fixture.sampleHistory
      .filter((entry) => kinds(entry.kind))
      .reduce((sum, entry) => sum + Number(entry.amount), 0);

  it('starts with earlier sample entries in the Market currency', async () => {
    const harness = await createHarness({ settings, sampleHistory: true });
    const balance = await harness.api.balance(20);
    expect(balance.entries).toHaveLength(fixture.sampleHistory.length);
    expect(balance.entries.every((entry) => entry.amount.currency === settings.currency)).toBe(
      true,
    );
    const times = balance.entries.map((entry) => Date.parse(entry.occurredAt));
    expect([...times].sort((a, b) => b - a)).toEqual(times);
    expect(balance.balance.total.amount).toBe(String(minor(() => true)));
    await expect(harness.api.earnings()).resolves.toMatchObject({
      today: { amount: '0' },
      week: { amount: String(minor((kind) => kind !== 'payout')) },
    });

    await renderWith(harness, <EarningsScreen onBack={jest.fn()} />);
    await screen.findByText('Paid to your account');
    expect(screen.getByText(money(minor((kind) => kind !== 'payout')))).toBeOnTheScreen();
    expect(screen.getByText(money(minor(() => true)))).toBeOnTheScreen();
    expect(screen.queryByText('No earnings yet. Completed deliveries show here.')).toBeNull();
  });
});
