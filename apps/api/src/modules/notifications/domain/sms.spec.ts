import { notificationSettings } from '../../../../test/support/notifications-markets';
import { TEST_MARKET_IDS } from '../../../../test/support/test-config';
import { SMS_KINDS } from './delivery-change';
import {
  isAllowedRecipient,
  parsePhoneNumber,
  renderSms,
  safeReference,
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
