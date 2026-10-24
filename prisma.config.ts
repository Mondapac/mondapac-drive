import { defineConfig } from 'prisma/config';

// Prisma CLI configuration. One schema file per module under prisma/schema/, migrations with a
// down.sql each, as in the marketplace repository. Commands connect as the migration role
// through MIGRATION_DATABASE_URL and never fall back to the application's login.
try {
  process.loadEnvFile();
} catch {
  // No .env file: rely on the real environment (CI, the migration job).
}

export default defineConfig({
  schema: 'prisma/schema',
  migrations: { path: 'prisma/migrations' },
  datasource: {
    url: process.env.MIGRATION_DATABASE_URL ?? 'postgresql://missing-MIGRATION_DATABASE_URL',
  },
});
