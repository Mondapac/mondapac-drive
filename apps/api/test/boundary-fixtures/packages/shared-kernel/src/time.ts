// Allowed: time.ts is the only kernel file that may import the polyfill.
import { isMinted } from './minted';

export { Temporal } from 'temporal-polyfill';
export const notMinted = isMinted;
