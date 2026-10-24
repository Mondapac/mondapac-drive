import type { LookupAddress } from 'node:dns';
import type { WebhookUrl } from '../domain/webhook-url';
import {
  guardedLookup,
  HttpsWebhookTransport,
  PrivateAddressError,
} from './https-webhook-transport';

const resolverOf =
  (...addresses: string[]) =>
  (): Promise<LookupAddress[]> =>
    Promise.resolve(
      addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 })),
    );

function lookUp(addresses: string[], all: boolean) {
  return new Promise<{ error: Error | null; result: unknown }>((resolve) =>
    guardedLookup(resolverOf(...addresses))('hooks.example.com', { all }, (error, result) =>
      resolve({ error, result }),
    ),
  );
}

describe('guarded DNS lookup of webhook hosts', () => {
  it('connects to a public address', async () => {
    expect(await lookUp(['93.184.216.34'], false)).toEqual({
      error: null,
      result: '93.184.216.34',
    });
  });

  it('hands every address on when the socket asks for all of them', async () => {
    const { error, result } = await lookUp(['93.184.216.34', '2606:4700::1111'], true);
    expect(error).toBeNull();
    expect(result).toHaveLength(2);
  });

  it.each([[['10.0.0.1']], [['93.184.216.34', '127.0.0.1']], [['169.254.169.254']], [[]]])(
    'refuses %j: every address must be public',
    async (addresses) => {
      const { error } = await lookUp(addresses, false);
      expect(error).toBeInstanceOf(PrivateAddressError);
    },
  );
});

describe('HTTPS webhook transport', () => {
  it('never connects to a literal private address', async () => {
    const transport = new HttpsWebhookTransport(resolverOf('93.184.216.34'));
    await expect(transport.post('https://127.0.0.1/hook' as WebhookUrl, {}, '{}')).resolves.toEqual(
      {
        ok: false,
        errorCode: 'webhook-url.private-host',
        statusCode: null,
        retryable: false,
      },
    );
  });

  it('never connects when the name resolves to a private address (DNS rebinding)', async () => {
    const transport = new HttpsWebhookTransport(resolverOf('127.0.0.1'));
    await expect(
      transport.post('https://hooks.example.com/hook' as WebhookUrl, {}, '{}'),
    ).resolves.toEqual({
      ok: false,
      errorCode: 'webhook-url.private-host',
      statusCode: null,
      retryable: false,
    });
  });
});
