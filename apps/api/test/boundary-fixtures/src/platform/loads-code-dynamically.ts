import { createRequire } from 'node:module';

// Violations: code loaded where dependency-cruiser cannot see it.
export const violations = [
  (entry: string): Promise<unknown> => import(entry),
  createRequire,
  () => require,
  () => process.mainModule,
  (code: string): unknown => eval(code),
];

// Allowed: a dynamic import of a literal is a dependency that dependency-cruiser checks.
export const allowed = (): Promise<unknown> => import('./uses-vertical');
