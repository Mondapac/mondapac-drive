import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/** One mail the application sent, as Mailpit's send interface receives it. */
export interface CaughtMail {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
}

/**
 * A stand-in for Mailpit's `POST /api/v1/send`, on a loopback port of the seed's own process.
 * The application keeps its real mail adapter (`MAIL_CATCHER_URL` points here), so the seed
 * reads invitation links exactly as a person would from their inbox, and no mail leaves the
 * machine. Bodies stay in memory and are dropped with the process.
 */
export class SeedMailCatcher {
  readonly #mails: CaughtMail[];
  readonly #server: Server;

  private constructor(server: Server, mails: CaughtMail[]) {
    this.#server = server;
    this.#mails = mails;
  }

  static async start(): Promise<SeedMailCatcher> {
    const mails: CaughtMail[] = [];
    const server = createServer((request, response) => {
      if (request.method !== 'POST' || request.url !== '/api/v1/send') {
        response.writeHead(404).end();
        return;
      }
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
            To?: { Email?: string }[];
            Subject?: string;
            Text?: string;
          };
          for (const to of body.To ?? []) {
            mails.push({
              to: (to.Email ?? '').toLowerCase(),
              subject: body.Subject ?? '',
              text: body.Text ?? '',
            });
          }
          response.writeHead(200, { 'content-type': 'application/json' }).end('{"ID":"seed"}');
        } catch {
          response.writeHead(400).end();
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return new SeedMailCatcher(server, mails);
  }

  get url(): string {
    const { port } = this.#server.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  }

  /**
   * The token of the newest link mailed to `to` (the fragment or `token` parameter of the first
   * URL in the body), waiting for the worker loop to send it.
   */
  async linkTokenFor(to: string, timeoutMs = 30_000): Promise<string> {
    const deadline = performance.now() + timeoutMs;
    for (;;) {
      const mail = this.#mails.findLast((candidate) => candidate.to === to.toLowerCase());
      const token = mail === undefined ? null : linkTokenOf(mail.text);
      if (token !== null) return token;
      if (performance.now() > deadline) throw new Error(`no link mail reached ${to} in time`);
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
  }
}

/** The token a link page reads: `#token=...`, `#...` or `?token=...` of the first https URL. */
export function linkTokenOf(text: string): string | null {
  const url = /https?:\/\/\S+/.exec(text)?.[0];
  if (url === undefined) return null;
  const parsed = new URL(url);
  const fragment = parsed.hash.replace(/^#/, '');
  const fromFragment = new URLSearchParams(fragment).get('token') ?? (fragment || null);
  return fromFragment ?? parsed.searchParams.get('token');
}
