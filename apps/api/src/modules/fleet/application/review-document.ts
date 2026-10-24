import { Injectable } from '@nestjs/common';
import {
  err,
  type CallContext,
  type Id,
  type Result,
  type Temporal,
} from '@mondapac-drive/shared-kernel';
import { documentRejected, documentRevoked, documentVerified } from '../domain/audit-actions';
import {
  rejectDocument,
  revokeDocument,
  verifyDocument,
  type CourierState,
} from '../domain/courier';
import type { RejectionReason } from '../domain/documents';
import { isOperator } from './access';
import { CourierChanges } from './courier-changes';
import { forbidden, type FleetFailure } from './failure';

// An operator's review of a document the courier submitted. Every verification and rejection
// is audited; the audit row names the courier and the document, never the document's number.

type Outcome = Promise<Result<CourierState, FleetFailure>>;

@Injectable()
export class VerifyCourierDocument {
  constructor(private readonly changes: CourierChanges) {}

  execute(
    context: CallContext,
    courierId: Id<'Courier'>,
    documentId: Id<'CourierDocument'>,
    /** The expiry the operator read on the document; required when the document expires. */
    confirmedExpiresAt?: Temporal.Instant,
  ): Outcome {
    if (!isOperator(context)) return Promise.resolve(err(forbidden()));
    return this.changes.apply(context, courierId, {
      allowed: () => true,
      decide: (courier, _rules, now) =>
        verifyDocument(courier, documentId, confirmedExpiresAt, now),
      audit: (before, after) => {
        const declared = before.documents.find((d) => d.id === documentId);
        const confirmed = after.documents.find((d) => d.id === documentId);
        return documentVerified.entry(documentId, {
          after: {
            courierId: after.id,
            declaredExpiresAt: declared?.expiresAt ?? null,
            expiresAt: confirmed?.expiresAt ?? null,
          },
        });
      },
    });
  }
}

@Injectable()
export class RejectCourierDocument {
  constructor(private readonly changes: CourierChanges) {}

  execute(
    context: CallContext,
    courierId: Id<'Courier'>,
    documentId: Id<'CourierDocument'>,
    reason: RejectionReason,
  ): Outcome {
    if (!isOperator(context)) return Promise.resolve(err(forbidden()));
    return this.changes.apply(context, courierId, {
      allowed: () => true,
      decide: (courier, _rules, now) => rejectDocument(courier, documentId, reason, now),
      audit: (_before, after) =>
        documentRejected.entry(documentId, { after: { courierId: after.id, reason } }),
    });
  }
}

/** Withdraws a verified document that was cancelled or found false. */
@Injectable()
export class RevokeCourierDocument {
  constructor(private readonly changes: CourierChanges) {}

  execute(
    context: CallContext,
    courierId: Id<'Courier'>,
    documentId: Id<'CourierDocument'>,
    reason: RejectionReason,
  ): Outcome {
    if (!isOperator(context)) return Promise.resolve(err(forbidden()));
    return this.changes.apply(context, courierId, {
      allowed: () => true,
      decide: (courier, _rules, now) => revokeDocument(courier, documentId, reason, now),
      audit: (_before, after) =>
        documentRevoked.entry(documentId, { after: { courierId: after.id, reason } }),
    });
  }
}
