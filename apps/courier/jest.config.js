/** @type {import('jest').Config} */
module.exports = {
  preset: 'jest-expo',
  roots: ['<rootDir>/src', '<rootDir>/test'],
  setupFilesAfterEnv: ['<rootDir>/test/setup.ts'],
  // The first screen test of a file also pays for loading React Native and Expo; under CI, with
  // the other packages' tests running alongside, that alone has passed Jest's 5 s default.
  testTimeout: 15_000,
  moduleNameMapper: { '^@/(.*)$': '<rootDir>/src/$1' },
  // pnpm keeps packages under node_modules/.pnpm; React Native and Expo ship untranspiled code.
  transformIgnorePatterns: [
    'node_modules/(?!(?:\\.pnpm/[^/]+/node_modules/)?((jest-)?react-native|@react-native(-community)?|expo(nent)?|@expo(nent)?/.*|@expo-google-fonts/.*|react-navigation|@react-navigation/.*|expo-router|@tanstack/.*))',
  ],
};
