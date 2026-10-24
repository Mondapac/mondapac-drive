import { webhookKey, WebhookKeyRefusedError } from './notifications-secrets';

const databaseUrl = 'postgresql://drive_app:local@localhost:5432/drive';
const production = { nodeEnv: 'production', nodeEnvExplicit: true, databaseUrl } as const;
const test = { nodeEnv: 'test', nodeEnvExplicit: true, databaseUrl } as const;
const development = { nodeEnv: 'development', nodeEnvExplicit: true, databaseUrl } as const;
const key = Buffer.alloc(32, 9).toString('base64');

describe('webhook key', () => {
  it('reads a base64 key of at least 32 bytes', () => {
    expect(webhookKey({ NOTIFICATIONS_WEBHOOK_KEY: key }, production)).toEqual(
      new Uint8Array(32).fill(9),
    );
  });

  it('refuses a short or malformed key', () => {
    const short = Buffer.alloc(16, 1).toString('base64');
    expect(() => webhookKey({ NOTIFICATIONS_WEBHOOK_KEY: short }, production)).toThrow(
      WebhookKeyRefusedError,
    );
    expect(() => webhookKey({ NOTIFICATIONS_WEBHOOK_KEY: 'not base64!' }, test)).toThrow(
      WebhookKeyRefusedError,
    );
  });

  it('requires the key in production and when NODE_ENV was not set', () => {
    expect(() => webhookKey({}, production)).toThrow(WebhookKeyRefusedError);
    expect(() => webhookKey({}, { ...development, nodeEnvExplicit: false })).toThrow(
      WebhookKeyRefusedError,
    );
  });

  it('uses the local stand-in only in an explicit development or test run', () => {
    expect(webhookKey({}, test)).toHaveLength(32);
    expect(webhookKey({}, test)).toEqual(webhookKey({}, development));
  });

  it('derives the stand-in from the database URL, so the source alone cannot reproduce it', () => {
    const elsewhere = { ...development, databaseUrl: 'postgresql://drive_app:other@db:5432/drive' };
    expect(webhookKey({}, elsewhere)).not.toEqual(webhookKey({}, development));
  });

  it('refuses the stand-in wherever Twilio credentials are set', () => {
    expect(() => webhookKey({ TWILIO_ACCOUNT_SID: 'AC' + '0'.repeat(32) }, development)).toThrow(
      /Twilio/,
    );
    expect(() => webhookKey({ TWILIO_AUTH_TOKEN: '0'.repeat(32) }, test)).toThrow(/Twilio/);
  });
});
