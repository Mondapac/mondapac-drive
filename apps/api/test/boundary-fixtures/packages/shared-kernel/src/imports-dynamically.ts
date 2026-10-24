// Violation: the kernel imports nothing dynamically, so the polyfill stays in time.ts.
export const violation = (): Promise<unknown> => import('temporal-polyfill');
