// @ts-check
import eslint from '@eslint/js';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// Market identifiers must never appear as literals in core code: they belong in
// config/markets/ (same rule as the marketplace, ADR-0001 there). Extend when a market is added.
const MARKET_LITERAL = '\\b(AU|AUD|en-AU|Brisbane)\\b';
const noMarketLiterals = [
  {
    selector: `Literal[value=/${MARKET_LITERAL}/]`,
    message: 'Market identifier hardcoded in core code. Move it to config/markets/.',
  },
  {
    selector: `TemplateElement[value.raw=/${MARKET_LITERAL}/]`,
    message: 'Market identifier hardcoded in core code. Move it to config/markets/.',
  },
];

// Only the injected Clock reads the wall clock.
const noWallClock = [
  {
    selector: "NewExpression[callee.name='Date'][arguments.length=0]",
    message: 'no-wall-clock: take the current time from the injected Clock.',
  },
  {
    selector: "CallExpression[callee.object.name='Date'][callee.property.name='now']",
    message: 'no-wall-clock: take the current time from the injected Clock.',
  },
];

export default tseslint.config(
  { ignores: ['**/dist/**', '**/coverage/**', '**/node_modules/**', '**/generated/**'] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node } },
  },
  {
    files: ['apps/api/src/**/*.ts', 'packages/*/src/**/*.ts'],
    ignores: ['**/*.spec.ts', 'apps/api/src/platform/clock/**'],
    rules: { 'no-restricted-syntax': ['error', ...noMarketLiterals, ...noWallClock] },
  },
  {
    files: ['**/*.cjs'],
    languageOptions: { sourceType: 'commonjs' },
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
  prettier,
);
