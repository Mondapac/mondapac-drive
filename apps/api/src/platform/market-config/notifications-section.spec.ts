import { notificationsSchema } from './notifications-section';

// The `notifications` section of a Market file: a template names only known placeholders and the
// retry bounds are consistent, so a bad file stops the Region Stack at start-up.

const VALID = {
  webhooks: { maxAttempts: 8, firstRetrySeconds: 30, maxRetrySeconds: 3600 },
  sms: {
    senderId: 'Example',
    optOutText: 'Reply STOP to opt out',
    maxAttempts: 5,
    allowedCallingCodes: ['64'],
    templates: {
      booked: 'Booked {reference}: {trackingUrl}',
      on_the_way: 'On the way: {trackingUrl}',
      delivered: 'Delivered {reference}',
      failed: 'Not delivered {reference}',
    },
  },
};

const withTemplate = (booked: string) => ({
  ...VALID,
  sms: { ...VALID.sms, templates: { ...VALID.sms.templates, booked } },
});

describe('notifications section of a Market file', () => {
  it('accepts a complete section', () => {
    expect(notificationsSchema.safeParse(VALID).success).toBe(true);
  });

  it('accepts an E.164 sender number', () => {
    const section = { ...VALID, sms: { ...VALID.sms, senderId: '+61400000000' } };
    expect(notificationsSchema.safeParse(section).success).toBe(true);
  });

  it.each([
    ['an unknown placeholder', withTemplate('Hi {name}')],
    ['an unpaired brace', withTemplate('Booked {reference')],
    ['a control character', withTemplate('Booked\n{reference}')],
    ['a missing template', { ...VALID, sms: { ...VALID.sms, templates: { booked: 'x' } } }],
    [
      'a sender id over 11 characters',
      { ...VALID, sms: { ...VALID.sms, senderId: 'MondapacDrive' } },
    ],
    [
      'a retry cap below the first retry',
      { ...VALID, webhooks: { maxAttempts: 8, firstRetrySeconds: 60, maxRetrySeconds: 30 } },
    ],
    ['zero webhook attempts', { ...VALID, webhooks: { ...VALID.webhooks, maxAttempts: 0 } }],
  ])('refuses %s', (_name, section) => {
    expect(notificationsSchema.safeParse(section).success).toBe(false);
  });
});
