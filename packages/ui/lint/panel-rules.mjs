// Lint rules for panel code (ADR-0033 decisions 2 and 10, ADR-0034 decision 6), as
// no-restricted-syntax selectors. eslint.config.mjs applies them to the panel apps and to
// packages/ui; panel-rules.spec.mjs shows each rule fires and does not false-positive.

// A colour written as a value: hex (6 or 8 digits, or 3 or 4 with a letter, so "#123" in text passes), a colour function, an arbitrary
// colour utility, white/black utilities and Tailwind palette utilities (palette is off, but
// the class would silently render nothing).
export const RAW_COLOUR =
  '(^|[^\\w&])#((?=[0-9]*[a-fA-F])[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\\b' +
  '|\\b(rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch|color)\\(' +
  '|-\\[(#|rgb|hsl|oklch)' +
  '|(^|[\\s:!])(bg|text|border|ring|fill|stroke|from|to|via|outline|decoration)-(white|black)(?=$|[\\s\\x2f])' +
  '|(^|[\\s:!])(bg|text|border|ring|fill|stroke|from|to|via|outline|decoration)-(slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\\d';

// A physical (left/right) utility, with or without a variant prefix (md:, hover:, !).
export const PHYSICAL_UTILITY =
  '(^|[\\s:!])-?(' +
  '(pl|pr|ml|mr|left|right|scroll-ml|scroll-mr|inset-l|inset-r)-(\\d|\\[|px(?=$|[\\s\\x2f])|auto|full|1\\x2f2)' +
  '|(rounded|border)-(l|r|tl|tr|bl|br)(?=$|[\\s-])' +
  '|(text|float|clear)-(left|right)(?=$|\\s)' +
  ')';

const both = (regex, message) =>
  ['Literal', 'TemplateElement'].map((node) => ({
    selector:
      node === 'Literal' ? `Literal[value=/${regex}/]` : `TemplateElement[value.raw=/${regex}/]`,
    message,
  }));

export const panelSyntaxRules = [
  ...both(
    RAW_COLOUR,
    'panel-tokens-only: use a colour token (ADR-0033 decision 2), never a raw colour value.',
  ),
  ...both(
    PHYSICAL_UTILITY,
    'logical-properties-only: use start/end utilities (ps, pe, ms, me, start, end, border-s, border-e, text-start, text-end), ADR-0033 decision 10.',
  ),
  {
    selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']",
    message: 'no-raw-html: dangerouslySetInnerHTML is banned in the panels (ADR-0034 decision 6).',
  },
];
