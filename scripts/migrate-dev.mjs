// Creates a development migration and then regenerates the Prisma client, so the next
// typecheck sees the new models. Arguments go to `prisma migrate dev`:
//   pnpm db:migrate:dev --name add_identity_users
// Always pass --name when no terminal is attached (agents, CI): without it Prisma asks for
// the name interactively. Remember to add the migration's down.sql afterwards. Prisma
// connects as the migration role (MIGRATION_DATABASE_URL, through prisma.config.ts), which
// also creates the shadow database.
import { spawnSync } from 'node:child_process';

function run(args) {
  const result = spawnSync('pnpm', ['exec', 'prisma', ...args], {
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const args = process.argv.slice(2);
if (args.some((arg) => /[^\w=./:-]/.test(arg))) {
  console.error(
    'Unsupported characters in arguments; use letters, digits, "_", "-", ".", "=" only.',
  );
  process.exit(1);
}

run(['migrate', 'dev', ...args]);
run(['generate']);
