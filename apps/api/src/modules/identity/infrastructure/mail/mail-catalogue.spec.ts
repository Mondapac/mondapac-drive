import { Temporal } from '@mondapac-drive/shared-kernel';
import { testMarketContext } from '@mondapac-drive/shared-kernel/testing';
import {
  TEST_LOCALE_CONFIG_DIRS,
  TEST_MARKET_CONFIG_DIRS,
  TEST_MARKET_IDS,
} from '../../../../../test/support/test-config';
import {
  LocaleCatalogues,
  loadLocaleCatalogues,
} from '../../../../platform/i18n/locale-catalogues';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import { RandomLinkTokens } from '../links/random-link-tokens';
import {
  CatalogueMailComposer,
  formatDuration,
  MAIL_KEYS,
  MissingMailCatalogueError,
} from './mail-catalogue';

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const catalogues = loadLocaleCatalogues(TEST_LOCALE_CONFIG_DIRS);
const composer = new CatalogueMailComposer(markets, catalogues);
const URL_AU = 'https://courier.au.drive.mondapac.test/reset-password#ml1_TOKEN';

describe('CatalogueMailComposer (identity design 9; ux.md E1, E12)', () => {
  it('finds exactly the mail keys in every identity catalogue, real and synthetic', () => {
    expect(catalogues.locales()).toEqual(['en-AU', 'en-ZZ']);
    for (const locale of catalogues.locales()) {
      const messages = catalogues.messages('identity', locale)!;
      expect([locale, Object.keys(messages).sort()]).toEqual([locale, [...MAIL_KEYS].sort()]);
    }
  });

  it('writes the courier reset mail in the Market locale: AU en-AU, 1 hour', () => {
    const mail = composer.compose(testMarketContext('AU', 'default'), {
      template: 'reset-password',
      population: 'courier',
      url: URL_AU,
      lifetimeMinutes: 60,
    });

    expect(mail.subject).toBe('Reset the password for your Mondapac Drive courier account');
    expect(mail.text).toContain('The link works for 1 hour and only once.');
    expect(mail.text).toContain(`Choose a new password: ${URL_AU}`);
    expect(mail.text).toContain('This email is about your Mondapac Drive courier account.');
    expect(mail.text).toContain("If you didn't ask for this, you can ignore this email.");
    expect(mail.text).not.toMatch(/\{[a-z]+\}/);
    expect(mail.text).not.toMatch(/<[a-z]/i);
  });

  it('writes the courier invitation in the synthetic Market locale, with its own lifetime', () => {
    const url = 'https://courier.zz.test/einladung?ref=mail#mi1_TOKEN';
    const mail = composer.compose(testMarketContext('ZZ', 'default'), {
      template: 'invitation',
      population: 'courier',
      url,
      lifetimeMinutes: 7200,
    });

    expect(mail.subject).toBe('[ZZ] You are invited to deliver with Mondapac Drive');
    expect(mail.text).toContain(formatDuration('en-ZZ', 7200));
    expect(mail.text).toContain(`[ZZ] Accept the invitation: ${url}`);
    expect(mail.text).toContain('[ZZ] This email is about your Mondapac Drive courier account.');
    expect(mail.text).not.toMatch(/\{[a-z]+\}/);
  });

  it.each(['AU', 'ZZ'])(
    'writes the password-changed notice in %s with the time and no link',
    (code) => {
      const mail = composer.compose(testMarketContext(code, 'default'), {
        template: 'password-changed',
        population: 'courier',
        changedAt: Temporal.Instant.from('2026-10-14T01:02:03Z'),
      });

      expect(mail.text).not.toContain('://');
      expect(mail.text).toContain(
        catalogues.messages('identity', code === 'AU' ? 'en-AU' : 'en-ZZ')![
          'identity.mail.common.not-you'
        ],
      );
      expect(mail.text).not.toMatch(/\{[a-z]+\}/);
    },
  );

  it.each(['reset', 'locked', 'replaced'] as const)(
    'writes the admin two-step notice for a %s change, with no placeholder left',
    (change) => {
      const mail = composer.compose(testMarketContext('AU', 'default'), {
        template: 'second-factor-changed',
        population: 'admin',
        change,
        changedAt: Temporal.Instant.from('2026-10-14T01:02:03Z'),
      });

      expect(mail.subject).toContain('admin account');
      expect(mail.text).not.toMatch(/\{[a-z]+\}/);
    },
  );

  it('refuses a population without that mail (a courier has no second factor)', () => {
    expect(() =>
      composer.compose(testMarketContext('AU', 'default'), {
        template: 'enrol-second-factor',
        population: 'courier',
        url: 'https://x.test/',
        lifetimeMinutes: 60,
      }),
    ).toThrow(/courier/);
  });

  it('refuses at construction a hosted Market whose locale has no catalogue', () => {
    const auOnly = new LocaleCatalogues(
      new Map([['en-AU', new Map([['identity', catalogues.messages('identity', 'en-AU')!]])]]),
    );
    const withoutFooter = Object.fromEntries(
      Object.entries(catalogues.messages('identity', 'en-AU')!).filter(
        ([key]) => key !== 'identity.mail.common.footer',
      ),
    );
    const lacking = new LocaleCatalogues(
      new Map([
        ['en-AU', new Map([['identity', withoutFooter]])],
        ['en-ZZ', new Map([['identity', catalogues.messages('identity', 'en-ZZ')!]])],
      ]),
    );

    expect(() => new CatalogueMailComposer(markets, auOnly)).toThrow(MissingMailCatalogueError);
    expect(() => new CatalogueMailComposer(markets, lacking)).toThrow(
      /lacks identity\.mail\.common\.footer/,
    );
  });

  it('formats a lifetime as hours when whole, else minutes', () => {
    expect(formatDuration('en-AU', 60)).toBe('1 hour');
    expect(formatDuration('en-AU', 90)).toBe('90 minutes');
  });
});

describe('RandomLinkTokens (identity design 6.6)', () => {
  const tokens = new RandomLinkTokens();

  it('issues a prefixed 256-bit token and its SHA-256, a new one each time', () => {
    const first = tokens.issue();
    const second = tokens.issue();

    expect(first.token).toMatch(/^ml1_[A-Za-z0-9_-]{43}$/);
    expect(first.tokenHash).toHaveLength(32);
    expect(second.token).not.toBe(first.token);
    expect(tokens.hashOf(first.token)).toEqual(first.tokenHash);
  });

  it('refuses a token of another shape, a session token included', () => {
    expect(tokens.hashOf('ms1_' + 'A'.repeat(43))).toBeNull();
    expect(tokens.hashOf('ml1_short')).toBeNull();
    expect(tokens.hashOf('')).toBeNull();
  });
});
