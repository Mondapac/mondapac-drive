// The dispatch job of one delivery as the dispatcher routes answer it (handoff 22b): rounds of
// offers to couriers and the assignment. Ids and codes only; the addresses are the delivery's.

import type { Vehicle } from '../ops/types.ts';

export const JOB_STATUSES = [
  'WAITING',
  'OFFERING',
  'ASSIGNED',
  'EXHAUSTED',
  'COLLECTED',
  'CANCELLED',
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const OFFER_STATUSES = ['PENDING', 'ACCEPTED', 'DECLINED', 'EXPIRED', 'WITHDRAWN'] as const;
export type OfferStatus = (typeof OFFER_STATUSES)[number];

export interface SentOffer {
  readonly id: string;
  /** The courier's identity account id. */
  readonly courierId: string;
  readonly vehicle: Vehicle;
  readonly round: number;
  readonly status: OfferStatus;
  readonly sentAt: string;
  readonly expiresAt: string;
  readonly answeredAt: string | null;
}

export interface DispatchJob {
  readonly id: string;
  readonly deliveryId: string;
  readonly status: JobStatus;
  readonly round: number;
  readonly opensAt: string;
  readonly nextActionAt: string | null;
  readonly assignment: {
    readonly courierId: string;
    readonly vehicle: Vehicle;
    readonly method: 'offer' | 'manual';
    readonly at: string;
  } | null;
  readonly offers: readonly SentOffer[];
}

/** The dispatch module's keys the delivery screens read (the API checks them again). */
export const DISPATCH_PERMISSION = {
  jobView: 'dispatch.job.view',
  jobAssign: 'dispatch.job.assign',
} as const;

/** A dispatcher may assign or reassign from any job status but these. */
export const ASSIGN_CLOSED: ReadonlySet<JobStatus> = new Set(['COLLECTED', 'CANCELLED']);

/** The offers by round, newest round first; offers of one round in the order they were sent. */
export function offersByRound(
  offers: readonly SentOffer[],
): readonly { readonly round: number; readonly offers: readonly SentOffer[] }[] {
  const rounds = new Map<number, SentOffer[]>();
  for (const offer of offers) {
    const list = rounds.get(offer.round) ?? [];
    list.push(offer);
    rounds.set(offer.round, list);
  }
  return [...rounds.entries()]
    .sort(([a], [b]) => b - a)
    .map(([round, list]) => ({
      round,
      offers: [...list].sort((a, b) => a.sentAt.localeCompare(b.sentAt)),
    }));
}
