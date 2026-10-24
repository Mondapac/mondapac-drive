import { notificationSettings } from '../../../../test/support/notifications-markets';
import { TEST_MARKET_IDS } from '../../../../test/support/test-config';
import { SMS_KINDS } from './delivery-change';
import {
  isAllowedRecipient,
  parsePhoneNumber,
  renderSms,
  safeReference,
  trackingUrlFor,
  type PhoneNumber,
} from './sms';

const link = 'https://track.example.com/t/abc123';

describe.each(TEST_MARKET_IDS)('recipient SMS in %s', (marketId) => {
  const settings = notificationSettings.get(marketId).sms;

  it.each(SMS_KINDS)('renders the %s template with the opt-out text last', (kind) => {
    const text = renderSms(settings, kind, { reference: 'ORD-1', trackingUrl: link });
    expect(text.ok).toBe(true);
    if (!text.ok) return;
    expect(text.value.endsWith(` ${settings.optOutText}`)).toBe(true);
    expect(text.value).not.toMatch(/\{(reference|trackingUrl)\}/);
    if (settings.templates[kind].includes('{reference}')) expect(text.value).toContain('ORD-1');
    if (settings.templates[kind].includes('{trackingUrl}')) expect(text.value).toContain(link);
  });

  it('cannot send a template that needs the tracking link before tracking issued one', () => {
    const needsLink = SMS_KINDS.find((kind) => settings.templates[kind].includes('{trackingUrl}'));
    expect(needsLink).toBeDefined();
    expect(renderSms(settings, needsLink!, { reference: 'ORD-1' })).toEqual({
      ok: false,
      error: 'sms.tracking-link-missing',
    });
  });

  it('adds the PIN to the booked message only, and only as 4 to 8 digits', () => {
    const booked = renderSms(settings, 'booked', {
      reference: 'ORD-1',
      trackingUrl: link,
      pin: '4821',
    });
    const pinText = settings.pinText.replace('{pin}', '4821');
    expect(booked.ok && booked.value).toContain(` ${pinText} ${settings.optOutText}`);
    const delivered = renderSms(settings, 'delivered', { reference: 'ORD-1', pin: '4821' });
    expect(delivered.ok && delivered.value).not.toContain('4821');
    const without = renderSms(settings, 'booked', { reference: 'ORD-1', trackingUrl: link });
    expect(without.ok && without.value).not.toContain(settings.pinText.split('{pin}')[0]!.trim());
    for (const pin of ['12', '123456789', '12a4', 'http://x']) {
      expect(renderSms(settings, 'booked', { reference: 'R', trackingUrl: link, pin })).toEqual({
        ok: false,
        error: 'sms.pin-invalid',
      });
    }
  });

  it("puts a link token into the Market's tracking page", () => {
    const url = trackingUrlFor(settings, 'abc_DEF-123');
    expect(url).toBe(settings.trackingPageUrl.replace('{token}', 'abc_DEF-123'));
    expect(url.startsWith('https://')).toBe(true);
    expect(trackingUrlFor(settings, 'a/b?c')).not.toContain('a/b?c');
  });

  it('turns a domain-shaped reference into text no phone makes a link of', () => {
    const text = renderSms(settings, 'delivered', { reference: 'pay-now.io/x' });
    expect(text.ok && text.value).toContain('pay-nowiox');
    expect(text.ok && text.value).not.toMatch(/\w\.\w{2,}|\//);
  });

  it('sends only to the calling codes of the Market', () => {
    const [code] = settings.allowedCallingCodes;
    expect(isAllowedRecipient(settings, `+${code}4001112222` as PhoneNumber)).toBe(true);
    expect(isAllowedRecipient(settings, '+8823456789012' as PhoneNumber)).toBe(false);
  });

  it('keeps links and line breaks of a merchant reference out of the message', () => {
    const text = renderSms(settings, 'delivered', {
      reference: 'ORD-1 http://evil.example\nclick',
    });
    expect(text.ok && text.value).not.toMatch(/http:\/\/|\n| click/);
  });
});

describe('SMS values', () => {
  it('cuts a reference to the safe characters and 32 of them', () => {
    expect(safeReference('ab c#1/2_x.y-z')).toBe('abc#12_xy-z');
    expect(safeReference('x'.repeat(40))).toHaveLength(32);
  });

  it.each([
    ['+61 400 000 000', '+61400000000'],
    ['+81 (90) 1234-5678', '+819012345678'],
    ['+64.21.555.0100', '+64215550100'],
  ])('reads %s as E.164', (raw, expected) => {
    expect(parsePhoneNumber(raw)).toBe(expected);
  });

  it.each(['0400 000 000', '+0400000000', '+12345', '+61 400 000 000 ext 2', ''])(
    'refuses %s',
    (raw) => {
      expect(parsePhoneNumber(raw)).toBeUndefined();
    },
  );
});
