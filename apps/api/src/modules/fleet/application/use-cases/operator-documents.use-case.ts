import { err, type CallContext, type Id, type Result } from '@mondapac-drive/shared-kernel';
import type { Temporal } from '@mondapac-drive/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { DOCUMENT_REVIEW } from '../../contracts/permissions';
import {
  documentDownloaded,
  documentRejected,
  documentRevoked,
  documentVerified,
} from '../../domain/audit-actions';
import {
  rejectDocument,
  revokeDocument,
  verifyDocument,
  type CourierState,
} from '../../domain/courier';
import type { RejectionReason } from '../../domain/documents';
import { isOperator } from '../access';
import { readDocumentFile } from '../courier-reads';
import type { DocumentFile } from '../document-files';
import { forbidden, type FleetFailure } from '../failure';
import type { FleetDependencies } from '../fleet-dependencies';

// An operator's review of a document the courier submitted, and the document's file. Every
// verification, rejection and revocation is audited; the audit row names the courier and the
// document, never its number.

type Outcome<T> = Promise<Result<T, FleetFailure>>;

export interface CourierDocumentRef {
  readonly courierId: Id<'Courier'>;
  readonly documentId: Id<'CourierDocument'>;
}

export interface VerifyDocumentInput extends CourierDocumentRef {
  /** The expiry the operator read on the document; required when the document expires. */
  readonly confirmedExpiresAt?: Temporal.Instant;
}

export interface RefuseDocumentInput extends CourierDocumentRef {
  readonly reason: RejectionReason;
}

/** The operator checked the file against the original. Rule `permissions [fleet.document.review]`. */
export class VerifyCourierDocument extends UseCase<
  VerifyDocumentInput,
  CourierState,
  FleetFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'fleet.verify-courier-document',
    rule: { kind: 'permissions', allOf: [DOCUMENT_REVIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: FleetDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: VerifyDocumentInput): Outcome<CourierState> {
    if (!isOperator(context)) return Promise.resolve(err(forbidden()));
    const { documentId } = input;
    return this.deps.changes.apply(
      context,
      { id: input.courierId },
      {
        allowed: () => true,
        decide: (courier, _rules, now) =>
          verifyDocument(courier, documentId, input.confirmedExpiresAt, now),
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
      },
    );
  }
}

/** Rejects a submitted document with a reason code. Rule `permissions [fleet.document.review]`. */
export class RejectCourierDocument extends UseCase<
  RefuseDocumentInput,
  CourierState,
  FleetFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'fleet.reject-courier-document',
    rule: { kind: 'permissions', allOf: [DOCUMENT_REVIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: FleetDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: RefuseDocumentInput): Outcome<CourierState> {
    if (!isOperator(context)) return Promise.resolve(err(forbidden()));
    const { documentId, reason } = input;
    return this.deps.changes.apply(
      context,
      { id: input.courierId },
      {
        allowed: () => true,
        decide: (courier, _rules, now) => rejectDocument(courier, documentId, reason, now),
        audit: (_before, after) =>
          documentRejected.entry(documentId, { after: { courierId: after.id, reason } }),
      },
    );
  }
}

/**
 * Withdraws a verified document that was cancelled or found false. Like an expiry, it publishes
 * no event: dispatch asks the fleet at every assignment. Rule `permissions [fleet.document.review]`.
 */
export class RevokeCourierDocument extends UseCase<
  RefuseDocumentInput,
  CourierState,
  FleetFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'fleet.revoke-courier-document',
    rule: { kind: 'permissions', allOf: [DOCUMENT_REVIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: FleetDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: RefuseDocumentInput): Outcome<CourierState> {
    if (!isOperator(context)) return Promise.resolve(err(forbidden()));
    const { documentId, reason } = input;
    return this.deps.changes.apply(
      context,
      { id: input.courierId },
      {
        allowed: () => true,
        decide: (courier, _rules, now) => revokeDocument(courier, documentId, reason, now),
        audit: (_before, after) =>
          documentRevoked.entry(documentId, { after: { courierId: after.id, reason } }),
      },
    );
  }
}

/**
 * The file of a courier's document, for review: only reviewers, never every operator (identity
 * documents), and every download is audited before the bytes go out.
 * Rule `permissions [fleet.document.review]`.
 */
export class DownloadCourierDocument extends UseCase<
  CourierDocumentRef,
  DocumentFile,
  FleetFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'fleet.download-courier-document',
    rule: { kind: 'permissions', allOf: [DOCUMENT_REVIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: FleetDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: CourierDocumentRef,
  ): Promise<Result<DocumentFile, FleetFailure>> {
    if (!isOperator(context)) return err(forbidden());
    const file = await readDocumentFile(
      this.deps,
      context,
      { id: input.courierId },
      input.documentId,
      () => true,
    );
    if (file.ok) {
      await this.deps.changes.record(
        context,
        documentDownloaded.entry(input.documentId, { after: { courierId: input.courierId } }),
      );
    }
    return file;
  }
}
