# boundary-fixtures

A miniature source tree full of deliberate architecture violations. `test/boundaries.spec.ts`
runs the real dependency-cruiser and ESLint configuration against it and expects every
violation to be reported, which proves the boundary rules actually fail the build. These files
are excluded from the normal lint, typecheck and build.

- `src/` mirrors `apps/api/src/`; dependency-cruiser runs on it from this folder, as
  `pnpm boundaries` runs on `apps/api/src/`. Each file says whether it is a violation or an
  allowed case.
- `packages/shared-kernel/src/` is a miniature shared kernel. `tsconfig.json` maps
  `@mondapac-drive/shared-kernel`, `@mondapac-drive/shared-kernel/testing` and
  `@mondapac-drive/shared-kernel/contexts` to it, as
  `apps/api/tsconfig.json` maps them to the real kernel. The kernel's ESLint blocks in
  `eslint.config.mjs` name this folder next to the real one.
- `packages/shared-kernel/dist/` holds two stand-ins for the kernel's build output, so that
  the `dist/` branches of the kernel rules are tested whatever the build state. `dist/` is
  gitignored: they were added with `git add -f` and stay tracked.
