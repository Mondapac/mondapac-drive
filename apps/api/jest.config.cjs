/** @type {import('jest').Config} */
module.exports = {
  rootDir: '.',
  testEnvironment: 'node',
  moduleFileExtensions: ['js', 'json', 'ts'],
  testRegex: '.*\\.spec\\.ts$',
  transform: { '^.+\\.(t|j)s$': 'ts-jest' },
  moduleNameMapper: {
    '^@mondapac-drive/shared-kernel$': '<rootDir>/../../packages/shared-kernel/src/index.ts',
    // Fakes and builders (platform-foundations 8.1). Both entries map to the kernel's sources,
    // so tests load one copy of the kernel, as the built API loads one copy of its dist/.
    '^@mondapac-drive/shared-kernel/testing$':
      '<rootDir>/../../packages/shared-kernel/src/testing.ts',
    // The actor and call-context constructors (identity slice 1c): platform entry adapters only.
    '^@mondapac-drive/shared-kernel/contexts$':
      '<rootDir>/../../packages/shared-kernel/src/contexts.ts',
    // The authenticated-actor constructor (identity slice 2): identity's Authenticator only.
    '^@mondapac-drive/shared-kernel/authenticated-actor$':
      '<rootDir>/../../packages/shared-kernel/src/authenticated-actor.ts',
  },
  collectCoverageFrom: ['src/**/*.ts'],
  coverageDirectory: './coverage',
  // In CI, also report each failed test as a GitHub annotation, so the failing test can be read
  // from the check run without downloading the whole job log.
  reporters: process.env.GITHUB_ACTIONS ? ['default', 'github-actions'] : ['default'],
  // Shared CI runners are slower and noisier than a laptop: on the Node minimum leg single HTTP
  // specs went over Jest's 5 s default now and then. CI gets more time; locally the default stays,
  // so a test that really got slow still shows up there.
  ...(process.env.GITHUB_ACTIONS ? { testTimeout: 30_000 } : {}),
};
