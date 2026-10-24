import { ApprovedSellerZones } from '../application/use-cases/approved-seller-zones.use-case';

// Violation: no other file of sellers (a controller, a job) may import the zone use cases.
export const useCase = ApprovedSellerZones;
