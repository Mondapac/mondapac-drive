import type { PhoneNumber } from '../domain/sms';
import { TwilioSmsSender, UnconfiguredSmsSender, type FetchLike } from './twilio-sms-sender';
import { twilioCredentials } from './notifications-secrets';

const credentials = { accountSid: `AC${'1'.repeat(32)}`, authToken: 'f'.repeat(32) };
const to = '+61400000000' as PhoneNumber;

function fakeFetch(status: number, body: unknown) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl: FetchLike = (url, init) => {
    calls.push({ url, init });
    return Promise.resolve(new Response(JSON.stringify(body), { status }));
  };
  return { impl, calls };
}

describe('Twilio SMS sender', () => {
  it('posts the message form to the account and answers the message sid', async () => {
    const sid = `SM${'a'.repeat(32)}`;
    const fetch = fakeFetch(201, { sid });
    const result = await new TwilioSmsSender(credentials, fetch.impl).send(to, 'Mondapac', 'Hi');

    expect(result).toEqual({ ok: true, providerMessageId: sid });
    const [call] = fetch.calls;
    expect(call?.url).toBe(
      `https://api.twilio.com/2010-04-01/Accounts/${credentials.accountSid}/Messages.json`,
    );
    expect(call?.init.redirect).toBe('error');
    expect(new URLSearchParams(call?.init.body as string)).toEqual(
      new URLSearchParams({ To: to, From: 'Mondapac', Body: 'Hi' }),
    );
  });

  it.each([
    [400, { code: 21610 }, 'sms.twilio-400.21610', false],
    [429, {}, 'sms.twilio-429', true],
    [503, {}, 'sms.twilio-503', true],
  ])('maps HTTP %d to a code without the number or text', async (status, body, code, retryable) => {
    const result = await new TwilioSmsSender(credentials, fakeFetch(status, body).impl).send(
      to,
      'Mondapac',
      'Hi',
    );
    expect(result).toEqual({ ok: false, errorCode: code, retryable });
    expect(JSON.stringify(result)).not.toContain('400000000');
  });

  it('retries a network failure', async () => {
    const failing: FetchLike = () => Promise.reject(new Error(`connect failed for ${to}`));
    expect(await new TwilioSmsSender(credentials, failing).send(to, 'M', 'Hi')).toEqual({
      ok: false,
      errorCode: 'sms.network',
      retryable: true,
    });
  });

  it('fails every attempt, retryably, while SMS is not configured', async () => {
    expect(await new UnconfiguredSmsSender().send()).toEqual({
      ok: false,
      errorCode: 'sms.not-configured',
      retryable: true,
    });
  });
});

describe('Twilio credentials', () => {
  it('are off when neither variable is set', () => {
    expect(twilioCredentials({})).toBeNull();
  });

  it('are read when both are well formed', () => {
    expect(
      twilioCredentials({
        TWILIO_ACCOUNT_SID: credentials.accountSid,
        TWILIO_AUTH_TOKEN: credentials.authToken,
      }),
    ).toEqual(credentials);
  });

  it('stop the start-up when only one is set or one is malformed', () => {
    expect(() => twilioCredentials({ TWILIO_ACCOUNT_SID: credentials.accountSid })).toThrow();
    expect(() =>
      twilioCredentials({ TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: credentials.authToken }),
    ).toThrow();
  });
});
