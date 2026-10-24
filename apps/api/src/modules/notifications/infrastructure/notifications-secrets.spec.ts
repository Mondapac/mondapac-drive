import { webhookKey, WebhookKeyRefusedError } from './notifications-secrets';

const production = { nodeEnv: 'production', nodeEnvExplicit: true } as const;
const test = { nodeEnv: 'test', nodeEnvExplicit: true } as const;
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
    expect(() => webhookKey({}, { nodeEnv: 'development', nodeEnvExplicit: false })).toThrow(
      WebhookKeyRefusedError,
    );
  });

  it('uses the local stand-in only in an explicit development or test run', () => {
    expect(webhookKey({}, test)).toHaveLength(32);
    expect(webhookKey({}, test)).toEqual(
      webhookKey({}, { nodeEnv: 'development', nodeEnvExplicit: true }),
    );
  });
});
