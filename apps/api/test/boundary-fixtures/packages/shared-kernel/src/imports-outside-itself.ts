// Violations of the kernel import whitelist: a bare Node built-in, a node: specifier, a
// package, a path out of the package, and the polyfill outside time.ts.
export { EOL } from 'os';
export { sep } from 'node:path';
export { z } from 'zod';
export { thing } from '../../../src/modules/alpha/domain/thing';
export { Temporal } from 'temporal-polyfill';
