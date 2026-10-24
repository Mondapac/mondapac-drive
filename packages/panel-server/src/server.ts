// The panel server (ADR-0037 decision 9): a plain HTTP/1.1 server that cleans every request
// before Next.js handles it. `dev` and `start` both run this, never `next dev` or `server.js`.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import {
  applyClientAddress,
  type RefusalReason,
  parseClientAddressSource,
  refuseUntrustedAddress,
  type ClientAddressSource,
} from './client-address-source.ts';

type Handler = (request: IncomingMessage, response: ServerResponse) => unknown;
type UpgradeHandler = (request: IncomingMessage, socket: Duplex, head: Buffer) => unknown;

export interface PanelServerOptions {
  readonly source: ClientAddressSource;
  readonly handle: Handler;
  /** Dev only: the hot-reload socket goes through the same cleaning. */
  readonly handleUpgrade?: UpgradeHandler;
  /** One line per refusal: the reason and the peer, never the header value. */
  readonly warn?: (line: { msg: string; reason: RefusalReason; peer: string }) => void;
}

const defaultWarn: NonNullable<PanelServerOptions['warn']> = (line) =>
  console.warn(JSON.stringify({ level: 'warn', ...line }));

export function createPanelServer({
  source,
  handle,
  handleUpgrade,
  warn = defaultWarn,
}: PanelServerOptions): Server {
  const refuse = (reason: RefusalReason, peer: string): void =>
    warn({ msg: 'panel.client-address.untrusted', reason, peer });
  const server = createServer((request, response) => {
    if (!applyClientAddress(request, source, refuse)) {
      refuseUntrustedAddress(response);
      return;
    }
    void handle(request, response);
  });
  if (handleUpgrade !== undefined) {
    server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
      if (!applyClientAddress(request, source, refuse)) {
        // Written before closing so a client sees why; the body names no value.
        socket.end(
          'HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n',
          () => {
            socket.destroy();
          },
        );
        return;
      }
      void handleUpgrade(request, socket, head);
    });
  }
  return server;
}

export { parseClientAddressSource };
