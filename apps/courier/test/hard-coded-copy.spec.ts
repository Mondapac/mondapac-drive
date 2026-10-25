import ts from 'typescript';

// The app's TypeScript has no Node types; Jest runs this file in Node.
declare const __dirname: string;

/**
 * Copy shown to the courier comes from the translation files. This finds the two ways it can
 * be hard-coded in a component: text between JSX tags, and a string literal given to a prop
 * the courier reads or hears. The pseudo-locale test catches the rest at run time.
 */
const SPOKEN_PROPS = new Set([
  'accessibilityLabel',
  'accessibilityHint',
  'aria-label',
  'placeholder',
  'title',
  'label',
  'hint',
]);
const WORDS = /[A-Za-z]{2,}/;
const SRC = ts.sys.resolvePath(`${__dirname}/../src`);

function hardCodedCopy(path: string): string[] {
  const text = ts.sys.readFile(path) ?? '';
  const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found: string[] = [];
  const report = (node: ts.Node, copy: string) => {
    const { line } = file.getLineAndCharacterOfPosition(node.getStart());
    found.push(`${path.slice(SRC.length + 1)}:${line + 1} ${JSON.stringify(copy.trim())}`);
  };
  const visit = (node: ts.Node) => {
    if (ts.isJsxText(node) && WORDS.test(node.text)) report(node, node.text);
    if (
      ts.isJsxExpression(node) &&
      node.expression &&
      ts.isJsxElement(node.parent) &&
      (ts.isStringLiteral(node.expression) ||
        ts.isNoSubstitutionTemplateLiteral(node.expression)) &&
      WORDS.test(node.expression.text)
    ) {
      report(node, node.expression.text);
    }
    if (ts.isJsxAttribute(node) && SPOKEN_PROPS.has(node.name.getText(file))) {
      const value = node.initializer;
      const literal =
        value && ts.isJsxExpression(value) && value.expression ? value.expression : value;
      if (
        literal &&
        (ts.isStringLiteral(literal) || ts.isNoSubstitutionTemplateLiteral(literal)) &&
        WORDS.test(literal.text)
      ) {
        report(node, literal.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

it('shows no hard-coded copy in the app', () => {
  const files = ts.sys.readDirectory(SRC, ['.tsx']);
  expect(files.length).toBeGreaterThan(10);
  expect(files.flatMap(hardCodedCopy)).toEqual([]);
});
