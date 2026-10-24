/**
 * The end-to-end smoke run against a real local API (`pnpm --filter courier smoke`). It is not
 * part of `pnpm verify`: it needs a running API and a seeded courier (see README).
 * @type {import('jest').Config}
 */
module.exports = {
  ...require('./jest.config'),
  testEnvironment: 'node',
  setupFilesAfterEnv: [],
  testMatch: ['<rootDir>/test/smoke/**/*.smoke.ts'],
  testTimeout: 30_000,
};
