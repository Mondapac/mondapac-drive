/**
 * The end-to-end smoke run against a real local API (`pnpm --filter courier smoke`). It is not
 * part of `pnpm verify`: it needs a running API and a seeded courier (see README); CI runs it
 * after `pnpm dev:seed` (job "Courier smoke run").
 *
 * Plain Node, without the jest-expo preset: the preset installs Expo's native `fetch` as the
 * global, which has no native module under Node, so every request failed before it was sent.
 * The smoke code imports only the HTTP adapter, its schemas and domain rules, which need no
 * React Native; Babel still transforms them with the app's own config.
 * @type {import('jest').Config}
 */
const app = require('./jest.config');

module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/test/smoke'],
  testMatch: ['<rootDir>/test/smoke/**/*.smoke.ts'],
  moduleNameMapper: app.moduleNameMapper,
  transformIgnorePatterns: app.transformIgnorePatterns,
  testTimeout: 30_000,
};
