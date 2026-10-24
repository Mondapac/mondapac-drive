import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/** One request the fake received. */
export interface RecordedRequest {
  readonly method: string;
  readonly path: string;
  readonly query: URLSearchParams;
  readonly headers: IncomingMessage['headers'];
  readonly body: unknown;
}

/** What the fake answers: a status and a JSON body, optionally after a delay. */
export interface FakeAnswer {
  readonly status?: number;
  readonly body?: unknown;
  readonly delayMs?: number;
}

export type FakeHandler = (request: RecordedRequest) => FakeAnswer;

/**
 * A local stand-in for the Google Routes and Geocoding APIs (handoff 12: no real API calls in
 * CI). Each path answers from its handler; every request is recorded.
 */
export class FakeGoogleMapsServer {
  readonly requests: RecordedRequest[] = [];
  readonly #handlers = new Map<string, FakeHandler>();
  #server: Server | undefined;

  on(path: string, handler: FakeHandler): this {
    this.#handlers.set(path, handler);
    return this;
  }

  get baseUrl(): string {
    const address = this.#server?.address() as AddressInfo | null | undefined;
    if (address === null || address === undefined) throw new Error('fake server not started');
    return `http://127.0.0.1:${address.port}`;
  }

  /** Requests to one path. */
  calls(path: string): RecordedRequest[] {
    return this.requests.filter((request) => request.path === path);
  }

  async start(): Promise<void> {
    this.#server = createServer((req, res) => void this.#handle(req, res));
    await new Promise<void>((resolve) => this.#server!.listen(0, '127.0.0.1', resolve));
  }

  async stop(): Promise<void> {
    const server = this.#server;
    if (server === undefined) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    const url = new URL(req.url ?? '/', 'http://fake');
    const request: RecordedRequest = {
      method: req.method ?? 'GET',
      path: url.pathname,
      query: url.searchParams,
      headers: req.headers,
      body: raw === '' ? undefined : JSON.parse(raw),
    };
    this.requests.push(request);
    const handler = this.#handlers.get(url.pathname);
    const answer = handler === undefined ? { status: 404, body: {} } : handler(request);
    if (answer.delayMs !== undefined) {
      await new Promise((resolve) => setTimeout(resolve, answer.delayMs));
      if (res.destroyed) return;
    }
    res.writeHead(answer.status ?? 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(answer.body ?? {}));
  }
}

export const ROUTES_PATH = '/directions/v2:computeRoutes';
export const MATRIX_PATH = '/distanceMatrix/v2:computeRouteMatrix';
export const GEOCODE_PATH = '/maps/api/geocode/json';
