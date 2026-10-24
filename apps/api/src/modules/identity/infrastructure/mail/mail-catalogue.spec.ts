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
  ReasonInSubjectError,
} from './mail-catalogue';

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const catalogues = loadLocaleCatalogues(TEST_LOCALE_CONFIG_DIRS);
const composer = new CatalogueMailComposer(markets, catalogues);
const URL_AU = 'https://storefront.au.mondapac.test/account/confirm-email#ml1_TOKEN';

describe('CatalogueMailComposer (identity design 9; ux.md E1, E12)', () => {
  it('finds exactly the mail keys in every identity catalogue, real and synthetic', () => {
    expect(catalogues.locales()).toEqual(['en-AU', 'ja-JP']);
    for (const locale of catalogues.locales()) {
      const messages = catalogues.messages('identity', locale)!;
      expect([locale, Object.keys(messages).sort()]).toEqual([locale, [...MAIL_KEYS].sort()]);
    }
  });

  it('writes the confirmation mail in the Market locale: AU en-AU, 24 hours', () => {
    const mail = composer.compose(testMarketContext('AU', 'default'), {
      template: 'confirm-email',
      population: 'customer',
      url: URL_AU,
      lifetimeMinutes: 1440,
    });

    expect(mail.subject).toBe('Confirm your email for your MondaPac customer account');
    expect(mail.text).toContain('The link works for 24 hours and only once.');
    expect(mail.text).toContain(`Confirm email: ${URL_AU}`);
    expect(mail.text).toContain('This email is about your customer account.');
    expect(mail.text).toContain("If you didn't ask for this, you can ignore this email.");
    expect(mail.text).not.toMatch(/\{[a-z]+\}/);
    expect(mail.text).not.toMatch(/<[a-z]/i);
  });

  it('writes the confirmation mail in the Market locale: ZZ ja-JP, 12 hours', () => {
    const mail = composer.compose(testMarketContext('ZZ', 'default'), {
      template: 'confirm-email',
      population: 'customer',
      url: 'https://storefront.zz.test/konto/bestaetigen?ref=mail#ml1_TOKEN',
      lifetimeMinutes: 720,
    });

    expect(mail.subject).toBe('お客様アカウントのメールアドレスを確認してください');
    expect(mail.text).toContain(formatDuration('ja-JP', 720));
    expect(mail.text).toContain('12');
    expect(mail.text).not.toContain('MondaPac customer');
  });

  it('writes the existing-account notice with the sign-in page and no token', () => {
    const mail = composer.compose(testMarketContext('AU', 'default'), {
      template: 'existing-account',
      population: 'customer',
      url: 'https://storefront.au.mondapac.test/account/sign-in',
    });

    expect(mail.subject).toBe('You already have a MondaPac customer account');
    expect(mail.text).toContain('Sign in: https://storefront.au.mondapac.test/account/sign-in');
    expect(mail.text).not.toContain('ml1_');
  });

  it('writes the seller confirmation and notice with the seller account line (slice 5)', () => {
    const confirm = composer.compose(testMarketContext('AU', 'default'), {
      template: 'confirm-email',
      population: 'seller',
      url: 'https://seller.au.mondapac.test/confirm-email#ml1_TOKEN',
      lifetimeMinutes: 1440,
    });
    const notice = composer.compose(testMarketContext('ZZ', 'default'), {
      template: 'existing-account',
      population: 'seller',
      url: 'https://seller.zz.test/konto/anmelden',
    });

    expect(confirm.subject).toBe('Confirm your email for your MondaPac seller account');
    expect(confirm.text).toContain('This email is about your seller account.');
    expect(notice.subject).toBe('出品者アカウントはすでにあります');
    expect(notice.text).toContain('このメールは出品者アカウントについてです。');
  });

  it.each([
    [true, "We're reviewing your application"],
    [false, 'Sign in to go to your seller panel.'],
  ])('writes the seller welcome (E2) with its body by approval: required %s', (required, body) => {
    const mail = composer.compose(testMarketContext('AU', 'default'), {
      template: 'welcome',
      population: 'seller',
      url: 'https://seller.au.mondapac.test/sign-in',
      approvalRequired: required,
    });

    expect(mail.subject).toBe('Welcome to MondaPac: your seller account');
    expect(mail.text).toContain(body);
    expect(mail.text).toContain('View your account: https://seller.au.mondapac.test/sign-in');
    expect(mail.text).not.toMatch(/\{[a-z]+\}/);
  });

  it('writes the welcome in the synthetic Market locale too', () => {
    const mail = composer.compose(testMarketContext('ZZ', 'default'), {
      template: 'welcome',
      population: 'seller',
      url: 'https://seller.zz.test/konto/anmelden',
      approvalRequired: false,
    });

    expect(mail.subject).toBe('ようこそ：出品者アカウント');
    expect(mail.text).toContain('出品者パネル');
  });

  it.each([
    [
      'AU',
      'https://admin.au.mondapac.test/sellers/awaiting-review',
      'A seller application is waiting for review',
      'Open the review queue: https://admin.au.mondapac.test/sellers/awaiting-review',
      'This email is about your MondaPac admin account.',
    ],
    [
      'ZZ',
      'https://admin.zz.test/haendler/pruefung?ref=mail',
      '審査待ちの出品者申請があります',
      '審査キューを開く: https://admin.zz.test/haendler/pruefung?ref=mail',
      'このメールは管理者アカウントについてです。',
    ],
  ])(
    'writes the reviewer notice (E3, identity design 8.7) in the %s locale: fixed text, the queue link',
    (code, url, subject, action, accountLine) => {
      const mail = composer.compose(testMarketContext(code, 'default'), {
        template: 'reviewer-notice',
        population: 'admin',
        url,
      });

      expect(mail.subject).toBe(subject);
      expect(mail.text).toContain(action);
      expect(mail.text).toContain(accountLine);
      // A notice that answers no request of the reader: no "ignore this" line.
      for (const locale of catalogues.locales()) {
        expect(mail.text).not.toContain(
          catalogues.messages('identity', locale)!['identity.mail.common.ignore'],
        );
      }
      expect(mail.text).not.toMatch(/\{[a-z]+\}/);
      expect(mail.text).not.toMatch(/<[a-z]/i);
      expect(mail.text.split('\n').filter((line) => line.includes('://'))).toEqual([action]);
    },
  );

  it.each(['reset', 'locked', 'replaced'] as const)(
    'writes the seller two-step notice for a %s change, with no placeholder left',
    (change) => {
      const mail = composer.compose(testMarketContext('AU', 'default'), {
        template: 'second-factor-changed',
        population: 'seller',
        change,
        changedAt: Temporal.Instant.from('2026-10-14T01:02:03Z'),
      });

      expect(mail.subject).toContain('seller account');
      expect(mail.text).not.toMatch(/\{[a-z]+\}/);
    },
  );

  it('gives the reviewer notice no field for seller data (Jafar: canary seller)', () => {
    const canary = { sellerName: 'Canary Seller Wombat', sellerEmail: 'canary@seller.test' };
    const mail = composer.compose(testMarketContext('AU', 'default'), {
      template: 'reviewer-notice',
      population: 'admin',
      url: 'https://admin.au.mondapac.test/sellers/awaiting-review',
      // @ts-expect-error E3 carries no seller data: the mail type has no such field.
      sellerName: canary.sellerName,
    });

    for (const value of Object.values(canary)) {
      expect(mail.subject).not.toContain(value);
      expect(mail.text).not.toContain(value);
    }
  });

  it('refuses a population without a mail', () => {
    expect(() =>
      composer.compose(testMarketContext('AU', 'default'), {
        template: 'existing-account',
        population: 'admin',
        url: 'https://x.test/',
      }),
    ).toThrow(/admin/);
  });

  it('refuses at construction a catalogue that puts the reason in a subject (Hassan L2)', () => {
    const withReason = {
      ...catalogues.messages('identity', 'ja-JP')!,
      'identity.mail.seller-suspended.seller.subject': '停止: {reason}',
    };
    const bad = new LocaleCatalogues(
      new Map([
        ['en-AU', new Map([['identity', catalogues.messages('identity', 'en-AU')!]])],
        ['ja-JP', new Map([['identity', withReason]])],
      ]),
    );

    expect(() => new CatalogueMailComposer(markets, bad)).toThrow(ReasonInSubjectError);
    expect(() => new CatalogueMailComposer(markets, bad)).toThrow(
      /identity\.mail\.seller-suspended\.seller\.subject/,
    );
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
        ['ja-JP', new Map([['identity', catalogues.messages('identity', 'ja-JP')!]])],
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
