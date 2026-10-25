// The only entry point other code may import from this module (marketplace ADR-0008 decision 6).
export { PayoutsModule } from './payouts.module';
// For the operations panel's notifications: a payout line was transferred, or failed.
export { payoutLineFailed, payoutLineTransferred } from './domain/events';
// For dispatch's courier offer: what the courier will earn for the offered delivery.
export { EarningsQuote } from './application/use-cases/quote-offer-earning.use-case';
export type { OfferToQuote } from './application/use-cases/quote-offer-earning.use-case';
