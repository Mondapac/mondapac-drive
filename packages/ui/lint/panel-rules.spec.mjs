import { Linter } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, expect, it } from 'vitest';
import { panelSyntaxRules } from './panel-rules.mjs';

const linter = new Linter({ configType: 'flat' });
const config = [
  {
    files: ['**/*.tsx'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: { 'no-restricted-syntax': ['error', ...panelSyntaxRules] },
  },
];
const lint = (code) =>
  linter.verify(code, config, { filename: 'x.tsx' }).map((m) => m.message.split(':')[0]);

describe('panel lint rules', () => {
  it.each([
    ['<a className="bg-[#fff]" />', 'panel-tokens-only'],
    ['const c = "#1D4FD7";', 'panel-tokens-only'],
    ['const c = "rgb(0 0 0)";', 'panel-tokens-only'],
    ['<a className="text-white" />', 'panel-tokens-only'],
    ['<a className="hover:bg-red-500" />', 'panel-tokens-only'],
    ['<a className={`bg-[#fff] ${x}`} />', 'panel-tokens-only'],
    ['<a className="pl-4" />', 'logical-properties-only'],
    ['<a className="md:pl-4" />', 'logical-properties-only'],
    ['<a className="flex hover:left-0" />', 'logical-properties-only'],
    ['<a className="sm:text-left" />', 'logical-properties-only'],
    ['<a className="float-right" />', 'logical-properties-only'],
    ['<a className="border-l" />', 'logical-properties-only'],
    ['<a className="rounded-tl-lg" />', 'logical-properties-only'],
    ['<a className="-ml-2" />', 'logical-properties-only'],
    ['<a className={`px-2 pr-3 ${x}`} />', 'logical-properties-only'],
    ['<a dangerouslySetInnerHTML={{ __html: x }} />', 'no-raw-html'],
  ])('refuses %s', (code, rule) => {
    expect(lint(code)).toContain(rule);
  });

  it.each([
    '<a className="bg-surface text-fg ps-4 pe-2 ms-auto text-start border-s rounded-md" />',
    '<a className="hover:bg-accent md:ps-4 start-0 end-0 inset-s-0" />',
    'const text = "Use the right-hand menu or the left side bar";',
    'const order = "Order #123";',
    'const url = "/settings#section";',
    '<a className="bg-transparent px-3 py-2 border border-line" />',
  ])('allows %s', (code) => {
    expect(lint(code)).toEqual([]);
  });
});
