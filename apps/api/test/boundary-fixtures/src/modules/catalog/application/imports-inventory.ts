import { inventoryFacade } from '../../inventory';

// Violation (catalog-imports-neither-pricing-nor-inventory): catalog never reads stock.
export const violation = inventoryFacade;
