import { testAppConfig } from '../../../test/support/test-config';
import { loadAppConfig } from '../config/app-config';
import { MailSendError, type MailMessage } from './mail-transport';
import { MailCatcherNotAllowedError, mailTransportFor } from './mail.module';
import {
  MailpitHttpTransport,
  UnconfiguredMailTransport,
  type Fetch,
} from './mailpit-http-transport';

const message: MailMessage = {
  to: 'someone@example.test',
  from: { address: 'no-reply@au.mondapac.test', name: 'MondaPac' },
  subject: 'Confirm your email',
  text: 'Open https://panel.example.test/confirm#ml1_secret',
};

describe('MailpitHttpTransport (identity design 9; spike 4)', () => {
  it('posts the message as JSON to /api/v1/send, plain text only', async () => {
    const calls: { url: string; body: unknown; headers: Record<string, string> }[] = [];
    const fetchFn: Fetch = (url, init) => {
      calls.push({ url, body: JSON.parse(init.body), headers: init.headers });
      return Promise.resolve({ ok: true, status: 200 });
    };

    await new MailpitHttpTransport('http://localhost:8025', fetchFn).send(message);

    expect(calls).toEqual([
      {
        url: 'http://localhost:8025/api/v1/send',
        headers: { 'content-type': 'application/json' },
        body: {
          From: { Email: 'no-reply@au.mondapac.test', Name: 'MondaPac' },
          To: [{ Email: 'someone@example.test' }],
          Subject: 'Confirm your email',
          Text: 'Open https://panel.example.test/confirm#ml1_secret',
        },
      },
    ]);
  });

  it('sends the one-click unsubscribe headers of a marketing mail (RFC 8058)', async () => {
    const bodies: unknown[] = [];
    const fetchFn: Fetch = (_url, init) => {
      bodies.push(JSON.parse(init.body));
      return Promise.resolve({ ok: true, status: 200 });
    };
    const url = 'https://api.au.mondapac.test/notifications/unsubscribe/AU?token=u1.abc';

    await new MailpitHttpTransport('http://localhost:8025', fetchFn).send({
      ...message,
      listUnsubscribe: url,
    });

    expect(bodies[0]).toMatchObject({
      Headers: {
        'List-Unsubscribe': `<${url}>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
    });
  });

  const refused: Fetch = () => Promise.resolve({ ok: false, status: 400 });
  const unreachable: Fetch = () =>
    Promise.reject(new TypeError('fetch failed: connect ECONNREFUSED'));
  const timedOut: Fetch = () =>
    Promise.reject(Object.assign(new Error('timed out'), { name: 'TimeoutError' }));

  it.each([
    ['a refusal', refused, 'mail.transport-refused'],
    ['a network error', unreachable, 'mail.transport-unreachable'],
    ['a timeout', timedOut, 'mail.transport-timeout'],
  ] as const)(
    'fails on %s with a code only, never the address or the body',
    async (_case, fetchFn, code) => {
      const error = await new MailpitHttpTransport('http://localhost:8025', fetchFn)
        .send(message)
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(MailSendError);
      expect((error as MailSendError).code).toBe(code);
      expect(JSON.stringify(error) + String(error)).not.toMatch(/someone|ml1_|secret/);
    },
  );
});

describe('mailTransportFor', () => {
  const catcher = { MAIL_CATCHER_URL: 'http://localhost:8025' };
  const base = {
    APP_ROLE: 'worker',
    HOSTED_MARKETS: 'AU',
    DATABASE_URL: 'postgresql://u:p@localhost:5432/d',
    ...catcher,
  };

  it('fails every send when no catcher is configured', async () => {
    const transport = mailTransportFor(testAppConfig());
    expect(transport).toBeInstanceOf(UnconfiguredMailTransport);
    await expect(transport.send(message)).rejects.toMatchObject({
      code: 'mail.transport-unconfigured',
    });
  });

  it('uses the catcher only when NODE_ENV is explicitly development or test', () => {
    expect(mailTransportFor(testAppConfig(catcher))).toBeInstanceOf(MailpitHttpTransport);
    expect(mailTransportFor(loadAppConfig({ ...base, NODE_ENV: 'development' }))).toBeInstanceOf(
      MailpitHttpTransport,
    );
    expect(() => mailTransportFor(loadAppConfig(base))).toThrow(MailCatcherNotAllowedError);
    expect(() => mailTransportFor(loadAppConfig({ ...base, NODE_ENV: 'production' }))).toThrow(
      MailCatcherNotAllowedError,
    );
  });
});
