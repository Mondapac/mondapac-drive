// The admin panel's server (ADR-0037 decision 9). `pnpm dev` and `pnpm start` both run this file,
// never `next dev` or the standalone `server.js`: it cleans every request before Next.js sees it
// and sets `x-drive-client-address` from the socket peer or, behind a trusted edge, from the one
// header the edge is configured to set. Node 24 strips the types of the workspace TypeScript.
import next from 'next';
import { createPanelServer, parseClientAddressSource } from '@mondapac-drive/panel-server/wrapper';

const dev = process.argv.includes('--dev');
const port = Number(process.env.PORT ?? 3002);

// `next` loads .env.local itself, but this file needs CLIENT_ADDRESS_SOURCE before Next starts.
for (const file of ['.env.local', '.env']) {
  try {
    process.loadEnvFile(file);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

const source = parseClientAddressSource(process.env);
// `next dev` sets TURBOPACK for its server process; the programmatic API needs to be told.
if (dev) process.env.TURBOPACK = '1';
const app = next({ dir: import.meta.dirname, dev, port, hostname: dev ? 'localhost' : undefined });
await app.prepare();

const server = createPanelServer({
  source,
  handle: app.getRequestHandler(),
  handleUpgrade: dev ? app.getUpgradeHandler() : undefined,
});
server.listen(port, () => {
  console.log(
    JSON.stringify({ msg: 'panel.listening', port, dev, clientAddressSource: source.mode }),
  );
});
