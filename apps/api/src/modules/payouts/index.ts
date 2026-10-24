// The only entry point other code may import from this module (marketplace ADR-0008 decision 6).
export { PayoutsModule } from './payouts.module';
// For the operations panel's notifications: a payout line was transferred, or failed.
export { payoutLineFailed, payoutLineTransferred } from './domain/events';
