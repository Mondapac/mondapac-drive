/**
 * How a courier works for the fleet (hybrid fleet): an employee is paid through payroll and earns
 * nothing per delivery; a contractor earns per delivery and is paid out by Drive.
 */
export type Engagement = 'employee' | 'contractor';

/**
 * What payouts needs to know about a courier, read from the fleet module by courier id. Payouts
 * never stores the business id itself, only whether fleet has verified one.
 */
export interface Payee {
  readonly courierId: string;
  readonly engagement: Engagement;
  /** Registered for the Market's indirect tax (AU: GST). */
  readonly taxRegistered: boolean;
  /** Fleet holds a verified business id (AU: ABN) for this courier. */
  readonly businessIdVerified: boolean;
}
