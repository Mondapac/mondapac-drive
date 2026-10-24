import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Shared CI runners are slower and noisier than a laptop: on the Node minimum leg single tests
    // went over Vitest's 5 s default now and then. CI gets more time; locally the default stays.
    ...(process.env.GITHUB_ACTIONS ? { testTimeout: 30_000 } : {}),
  },
  resolve: {
    alias: {
      // The real package throws outside React Server Components; the marker means nothing in tests.
      'server-only': fileURLToPath(new URL('./test/server-only.ts', import.meta.url)),
    },
  },
});
