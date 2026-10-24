import { attached } from './market-context/attached-market-context';

// Violation: only the Market guard and the @Market() decorator file reach the request map.
export const violation = attached;
