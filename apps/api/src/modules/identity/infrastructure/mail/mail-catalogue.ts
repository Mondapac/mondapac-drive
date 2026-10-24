import type { MarketContext, Temporal } from '@mondapac-drive/shared-kernel';
import type { LocaleCatalogues } from '../../../../platform/i18n/locale-catalogues';
import type { MarketRegistry } from '../../../../platform/market-config/market-registry';
import type {
  ComposedMail,
  IdentityMail,
  IdentityMailComposer,
} from '../../application/ports/identity-mails';

/** Every key the `identity` catalogue of a Market's default locale must hold. */
export const MAIL_KEYS = [
  'identity.mail.reset-password.admin.subject',
  'identity.mail.reset-password.admin.heading',
  'identity.mail.reset-password.admin.body',
  'identity.mail.reset-password.admin.action',
  'identity.mail.password-changed.admin.subject',
  'identity.mail.password-changed.admin.heading',
  'identity.mail.password-changed.admin.body',
  'identity.mail.other-sessions-signed-out.admin.subject',
  'identity.mail.other-sessions-signed-out.admin.heading',
  'identity.mail.other-sessions-signed-out.admin.body',
  'identity.mail.invitation.admin.subject',
  'identity.mail.invitation.admin.heading',
  'identity.mail.invitation.admin.body',
  'identity.mail.invitation.admin.action',
  'identity.mail.reset-password.courier.subject',
  'identity.mail.reset-password.courier.heading',
  'identity.mail.reset-password.courier.body',
  'identity.mail.reset-password.courier.action',
  'identity.mail.password-changed.courier.subject',
  'identity.mail.password-changed.courier.heading',
  'identity.mail.password-changed.courier.body',
  'identity.mail.other-sessions-signed-out.courier.subject',
  'identity.mail.other-sessions-signed-out.courier.heading',
  'identity.mail.other-sessions-signed-out.courier.body',
  'identity.mail.invitation.courier.subject',
  'identity.mail.invitation.courier.heading',
  'identity.mail.invitation.courier.body',
  'identity.mail.invitation.courier.action',
  'identity.mail.enrol-second-factor.admin.subject',
  'identity.mail.enrol-second-factor.admin.heading',
  'identity.mail.enrol-second-factor.admin.body',
  'identity.mail.enrol-second-factor.admin.action',
  'identity.mail.second-factor-changed.admin.subject',
  'identity.mail.second-factor-changed.admin.heading',
  'identity.mail.second-factor-changed.admin.body.replaced',
  'identity.mail.second-factor-changed.admin.body.reset',
  'identity.mail.second-factor-changed.admin.body.locked',
  'identity.mail.common.account-line.admin',
  'identity.mail.common.account-line.courier',
  'identity.mail.common.ignore',
  'identity.mail.common.not-you',
  'identity.mail.common.footer',
] as const;
export type MailKey = (typeof MAIL_KEYS)[number];
export type MailCatalogue = Readonly<Record<MailKey, string>>;

/** A hosted Market whose default locale lacks a mail text: refused at boot. */
export class MissingMailCatalogueError extends Error {
  override readonly name = 'MissingMailCatalogueError';
  constructor(marketId: string, locale: string, missing: readonly string[]) {
    super(
      `identity's ${locale} catalogue, the default locale of Market ${marketId}, lacks ` +
        `${missing.join(', ')}`,
    );
  }
}

const PLACEHOLDER = /\{([a-z]+)\}/g;

/**
 * {@link IdentityMailComposer} from `identity`'s translation catalogues (identity design 9,
 * INTL-11; `config/locales/<locale>/identity.json`): the Market's default locale, named
 * placeholders and no ICU. Plain text only: no markup can be produced, and the only values filled
 * in are the URL, which code built, and the duration and the time, which `Intl` formats (HF13). A
 * placeholder without a value throws, so a broken locale file never sends a mail with `{url}` in
 * it.
 */
export class CatalogueMailComposer implements IdentityMailComposer {
  readonly #byMarket = new Map<string, MailCatalogue>();

  /** Checks at boot that every hosted Market's default locale has every mail key. */
  constructor(
    private readonly markets: MarketRegistry,
    catalogues: LocaleCatalogues,
  ) {
    for (const marketId of markets.hostedMarketIds()) {
      const locale = markets.get(marketId).defaultLocale;
      const messages = catalogues.messages('identity', locale);
      const missing = MAIL_KEYS.filter((key) => messages?.[key] === undefined);
      if (messages === null || missing.length > 0) {
        throw new MissingMailCatalogueError(marketId, locale, missing);
      }
      this.#byMarket.set(marketId, messages);
    }
  }

  compose(market: MarketContext, mail: IdentityMail): ComposedMail {
    const locale = this.markets.get(market.marketId).defaultLocale;
    const catalogue = this.catalogueOf(market.marketId);
    const prefix = `identity.mail.${mail.template}.${mail.population}`;
    const key = (suffix: string): MailKey => {
      const name = `${prefix}.${suffix}`;
      if (!(MAIL_KEYS as readonly string[]).includes(name)) {
        throw new Error(
          `identity has no mail ${mail.template} for the ${mail.population} population`,
        );
      }
      return name as MailKey;
    };
    const values: Record<string, string> = {};
    if (
      mail.template === 'reset-password' ||
      mail.template === 'enrol-second-factor' ||
      mail.template === 'invitation'
    ) {
      values['duration'] = formatDuration(locale, mail.lifetimeMinutes);
    }
    const notice =
      mail.template === 'password-changed' ||
      mail.template === 'second-factor-changed' ||
      mail.template === 'other-sessions-signed-out';
    if (notice) {
      // A notice says when (`ux.md` 3.4): in the Market's zone, the fallback of ADR-0005, since
      // an account has no zone of its own; the zone's name is written with the time.
      const timezone = this.markets.get(market.marketId).timezone;
      values['time'] = formatInstant(locale, timezone, mail.changedAt);
    } else {
      values['url'] = mail.url;
    }
    const fill = (template: string): string =>
      template.replace(PLACEHOLDER, (_match, name: string) => {
        const value = values[name];
        if (value === undefined) throw new Error(`mail placeholder {${name}} has no value`);
        return value;
      });
    const line = (name: MailKey): string => fill(catalogue[name]);

    const accountLine = `identity.mail.common.account-line.${mail.population}`;
    if (!(MAIL_KEYS as readonly string[]).includes(accountLine)) {
      throw new Error(`identity has no account line for the ${mail.population} population`);
    }
    // The second-factor notice has one body per change (slice 7b).
    const body = mail.template === 'second-factor-changed' ? `body.${mail.change}` : 'body';
    // E13 and the factor notice have no button: "if this wasn't you" in place of "ignore this".
    const action = notice ? [] : [`${line(key('action'))}: ${(mail as { url: string }).url}`];
    const closing: MailKey[] = notice
      ? ['identity.mail.common.not-you']
      : ['identity.mail.common.ignore'];
    const text = [
      line(key('heading')),
      line(key(body)),
      ...action,
      line(accountLine as MailKey),
      ...closing.map(line),
      line('identity.mail.common.footer'),
    ].join('\n\n');
    // Subjects carry no personal data (`ux.md` 3.4).
    return { subject: line(key('subject')), text: `${text}\n` };
  }

  private catalogueOf(marketId: MarketContext['marketId']): MailCatalogue {
    const catalogue = this.#byMarket.get(marketId);
    if (catalogue === undefined) throw new Error(`Market ${marketId} is not hosted here`);
    return catalogue;
  }
}

/**
 * An instant as a date and time in the locale and zone, with the zone's name ("8 October 2026 at
 * 10:00:00 am AEST"): a notice's "when" (`ux.md` 3.4; ADR-0005 decision 3).
 */
export function formatInstant(locale: string, timeZone: string, instant: Temporal.Instant): string {
  return new Intl.DateTimeFormat(locale, {
    dateStyle: 'long',
    timeStyle: 'long',
    timeZone,
  }).format(new Date(instant.epochMilliseconds));
}

/**
 * A lifetime as a duration in the locale ("24 hours", "24時間"): whole hours when it divides,
 * otherwise minutes (identity design 9; no zone is needed, ADR-0005 decision 3).
 */
export function formatDuration(locale: string, minutes: number): string {
  const [value, unit] = minutes % 60 === 0 ? [minutes / 60, 'hour'] : [minutes, 'minute'];
  return new Intl.NumberFormat(locale, { style: 'unit', unit, unitDisplay: 'long' }).format(value);
}
