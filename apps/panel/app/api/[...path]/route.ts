import { panelConfig } from '../../../src/server/config.ts';
import { relay } from '../../../src/server/bff.ts';

export const dynamic = 'force-dynamic';

async function handle(request: Request, context: { params: Promise<{ path: string[] }> }) {
  const { path } = await context.params;
  return relay(panelConfig(), request, path);
}

export { handle as GET, handle as POST, handle as PUT, handle as DELETE };
