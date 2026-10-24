// The main entry of a miniature shared kernel. tsconfig.json maps @mondapac-drive/shared-kernel
// here and @mondapac-drive/shared-kernel/testing to testing.ts, as apps/api/tsconfig.json does.
export { mintMarketContext } from './market-context';
export type { MarketContext } from './market-context';
export { isMinted } from './minted';

// Violation (kernel-testing-only-in-tests): the main entry carries a fake.
export { FixedClock } from './testing';
