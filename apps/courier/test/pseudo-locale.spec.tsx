import { act, fireEvent, screen } from '@testing-library/react-native';
import { currentLocale, setLocaleForTesting, t } from '../src/i18n';
import { fallbackLocale, PSEUDO_LOCALE } from '../src/i18n/locales';
import { PSEUDO_CLOSE, PSEUDO_OPEN } from '../src/i18n/pseudo';
import { EarningsScreen } from '../src/screens/EarningsScreen';
import { HomeScreen } from '../src/screens/HomeScreen';
import { JobScreen } from '../src/screens/JobScreen';
import { LocationPermissionScreen } from '../src/screens/LocationPermissionScreen';
import { MARKETS } from './markets';
import { acceptNextOffer, createHarness, renderWith, type Harness } from './render';

/**
 * Every screen in pseudo-English: each piece of copy from the translation files comes out
 * accented and bracketed, so any plain word left on screen (or read out to a screen reader) was
 * hard-coded, unless it is data from the API, such as an address.
 */
beforeEach(() => setLocaleForTesting(PSEUDO_LOCALE));
afterEach(() => setLocaleForTesting(fallbackLocale()));

type Rendered = typeof screen.root;

const PSEUDO = new RegExp(`${PSEUDO_OPEN}[^${PSEUDO_CLOSE}]*${PSEUDO_CLOSE}`, 'g');

function shownCopy(root: Rendered): string[] {
  const copy: string[] = [];
  const visit = (node: Rendered | string) => {
    if (node === null) return;
    if (typeof node === 'string') {
      copy.push(node);
      return;
    }
    for (const prop of ['accessibilityLabel', 'accessibilityHint', 'placeholder', 'aria-label']) {
      const value: unknown = node.props[prop];
      if (typeof value === 'string') copy.push(value);
    }
    node.children.forEach(visit);
  };
  visit(root);
  return copy;
}

/** Plain words on screen that are neither pseudo-English nor in the API's own data. */
function hardCodedWords(data: unknown[]): string[] {
  const dataWords = new Set(JSON.stringify(data).match(/[A-Za-z]{2,}/g));
  return shownCopy(screen.root)
    .map((text) => text.replace(PSEUDO, ' '))
    .flatMap((text) => text.match(/[A-Za-z]{2,}/g) ?? [])
    .filter((word) => !dataWords.has(word));
}

async function apiData(harness: Harness, deliveryId?: string) {
  return [
    await harness.api.settings(),
    await harness.api.status(),
    await harness.api.earnings(),
    await harness.api.currentOffer(),
    deliveryId ? await harness.api.job(deliveryId) : null,
  ];
}

it('switches the copy and keeps placeholders', () => {
  expect(currentLocale().code).toBe(PSEUDO_LOCALE.code);
  expect(t('common.error', { message: 'x' })).toBe('⟦Šöɱéţĥîñĝ ŵéñţ ŵŕöñĝ. x⟧');
});

describe.each(MARKETS)('pseudo-English in $marketId', (settings) => {
  it('home, offline and with an offer', async () => {
    const harness = await createHarness({ settings });
    await renderWith(
      harness,
      <HomeScreen onOpenJob={jest.fn()} onOpenEarnings={jest.fn()} onNeedLocation={jest.fn()} />,
    );
    await screen.findByText(t('home.offline'));
    expect(hardCodedWords(await apiData(harness))).toEqual([]);
    await act(() => fireEvent.press(screen.getByRole('button', { name: t('home.goOnline') })));
    await screen.findByText(t('offer.title'));
    expect(hardCodedWords(await apiData(harness))).toEqual([]);
  });

  it('the active job', async () => {
    const harness = await createHarness({ settings });
    const deliveryId = await acceptNextOffer(harness);
    await renderWith(harness, <JobScreen deliveryId={deliveryId} onDone={jest.fn()} />);
    await screen.findByText(t('job.status.ASSIGNED'));
    expect(hardCodedWords(await apiData(harness, deliveryId))).toEqual([]);
  });

  it('earnings', async () => {
    const harness = await createHarness({ settings });
    await renderWith(harness, <EarningsScreen onBack={jest.fn()} />);
    await screen.findByText(t('earnings.title'));
    expect(hardCodedWords(await apiData(harness))).toEqual([]);
  });

  it('the location notice', async () => {
    const harness = await createHarness({ settings });
    await renderWith(
      harness,
      <LocationPermissionScreen onGranted={jest.fn()} onCancel={jest.fn()} />,
    );
    await screen.findByText(t('permissions.location.title'));
    expect(hardCodedWords(await apiData(harness))).toEqual([]);
  });
});
