import { Reflector } from '@nestjs/core';

// Only the guard file and platform/health/ may import this file (rule 6 of design 8.2): the
// exemption is for health and docs only (ADR-0015 decision 3). The guard file re-exports
// neither the decorator nor its key, only the predicate `isMarketContextExempt`.

/** The metadata key of the exemption. Read only by `isMarketContextExempt`. */
export const MARKET_CONTEXT_EXEMPTION = Reflector.createDecorator<void, true>({
  transform: () => true,
});

/**
 * Exempts a whole controller class from Market resolution. Class-level only: the type
 * refuses a method, and the guard reads the class itself, never a method or a parent class.
 */
export function NoMarketContext(): ClassDecorator {
  return MARKET_CONTEXT_EXEMPTION();
}
