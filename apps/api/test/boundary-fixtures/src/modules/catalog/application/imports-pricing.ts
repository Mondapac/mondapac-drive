import { pricingFacade } from '../../pricing';

// Violation (catalog-imports-neither-pricing-nor-inventory): catalog never reads a price.
export const violation = pricingFacade;
