import en from './en.json';

type Leaves<T, Prefix extends string = ''> = {
  [K in keyof T & string]: T[K] extends string ? `${Prefix}${K}` : Leaves<T[K], `${Prefix}${K}.`>;
}[keyof T & string];

/** A key of the translation file, such as `job.pickedUp`. */
export type TranslationKey = Leaves<typeof en>;

type Params = Readonly<Record<string, string | number>>;

/**
 * The copy for a key, with `{{name}}` placeholders filled in. English is the only language for
 * now; a second one adds a file next to en.json and a locale switch here.
 */
export function t(key: TranslationKey, params: Params = {}): string {
  let node: unknown = en;
  for (const part of key.split('.')) {
    node = (node as Record<string, unknown>)[part];
  }
  if (typeof node !== 'string') return key;
  return node.replace(/\{\{(\w+)\}\}/g, (match, name: string) =>
    name in params ? String(params[name]) : match,
  );
}
