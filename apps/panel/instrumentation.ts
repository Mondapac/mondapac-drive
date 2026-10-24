// Fails the server at start-up, not on the first request, when its configuration is malformed.
export async function register(): Promise<void> {
  if (process.env['NEXT_RUNTIME'] === 'nodejs') {
    const { panelConfig } = await import('./src/server/config.ts');
    panelConfig();
  }
}
