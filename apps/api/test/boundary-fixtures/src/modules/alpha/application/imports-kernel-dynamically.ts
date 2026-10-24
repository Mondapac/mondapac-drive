// Violation: a module has no import(), so a computed member of the kernel's namespace cannot
// reach mintMarketContext.
export const violation = async (): Promise<unknown> =>
  (await import('@mondapac-drive/shared-kernel'))[`mintMarketContext`];
