import { err, ok, type CallContext, type Id, type Result } from '@mondapac-drive/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { PROFILE_MANAGE, SHIFT_CHANGE } from '../../contracts/permissions';
import {
  addVehicle,
  changeShift,
  deactivateVehicle,
  registerCourier,
  type CourierState,
} from '../../domain/courier';
import type { EmploymentType } from '../../domain/courier-status';
import type { ShiftState } from '../../domain/shift';
import type { ColdBox, VehicleType } from '../../domain/vehicle';
import { capacityFor } from '../../domain/vehicle-class';
import { courierAccountOf } from '../access';
import {
  readCourier,
  readDocumentFile,
  submitCourierDocument,
  type DocumentUpload,
  type SubmittedCourierDocument,
} from '../courier-reads';
import type { DocumentFile } from '../document-files';
import { forbidden, refusingBrokenRules, type FleetFailure } from '../failure';
import type { FleetDependencies } from '../fleet-dependencies';
import type { CourierAppSettings } from '../ports';

// The courier app's fleet use cases. The courier is always the signed-in courier account, taken
// from the session, never from a path or a body: no courier can read or change another's profile.

export type { CourierAppSettings, DocumentFile, DocumentUpload, SubmittedCourierDocument };
export { MAX_DOCUMENT_BYTES } from '../document-files';

type NoInput = Record<string, never>;
type Outcome<T> = Promise<Result<T, FleetFailure>>;

const ownedBy = (account: string) => (courier: CourierState) => courier.actorId === account;

export interface ApplyAsCourierInput {
  readonly employmentType: EmploymentType;
  readonly serviceAreaCode: string;
  readonly coldChainCapable: boolean;
}

export interface RegisteredCourier {
  readonly courier: CourierState;
  readonly created: boolean;
}

/**
 * A courier account applies to deliver in the Market. Idempotent per account: applying again
 * answers the profile already there. The profile is an applicant until an operator approves it.
 * Rule `permissions [fleet.profile.manage]`, couriers only.
 */
export class ApplyAsCourier extends UseCase<ApplyAsCourierInput, RegisteredCourier, FleetFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'fleet.apply-as-courier',
    rule: { kind: 'permissions', allOf: [PROFILE_MANAGE.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: FleetDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: ApplyAsCourierInput,
  ): Outcome<RegisteredCourier> {
    const actorId = courierAccountOf(context);
    if (actorId === undefined) return err(forbidden());
    const { market } = context;
    const { couriers, rules, unitOfWork, ids, clock } = this.deps;
    if (!rules.hasServiceArea(market.marketId, input.serviceAreaCode)) {
      return err({
        code: 'fleet.service-area.unknown',
        message: 'The Market has no such service area',
      });
    }
    return unitOfWork.run(market, () =>
      refusingBrokenRules(async (): Outcome<RegisteredCourier> => {
        const existing = await couriers.findByActorId(market, actorId);
        if (existing !== undefined) return ok({ courier: existing, created: false });
        const courier = registerCourier({
          id: ids.next<'Courier'>(),
          marketId: market.marketId,
          actorId,
          employmentType: input.employmentType,
          serviceAreaCode: input.serviceAreaCode,
          coldChainCapable: input.coldChainCapable,
          createdAt: clock.now(),
        });
        if (await couriers.insert(market, courier)) return ok({ courier, created: true });
        const raced = await couriers.findByActorId(market, actorId);
        return raced
          ? ok({ courier: raced, created: false })
          : err({ code: 'fleet.conflict', message: 'The profile could not be saved; retry' });
      }),
    );
  }
}

/** The courier's own profile. Rule `permissions [fleet.profile.manage]`, couriers only. */
export class ViewOwnCourierProfile extends UseCase<NoInput, CourierState, FleetFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'fleet.view-own-courier-profile',
    rule: { kind: 'permissions', allOf: [PROFILE_MANAGE.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: FleetDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext): Outcome<CourierState> {
    const account = courierAccountOf(context);
    if (account === undefined) return Promise.resolve(err(forbidden()));
    return readCourier(this.deps, context, { accountId: account }, ownedBy(account));
  }
}

/**
 * The Market settings the courier app runs on: locale, currency, distance unit, support line,
 * offer time and cold-chain limits. Needs no profile. Rule `permissions [fleet.profile.manage]`.
 */
export class ViewCourierAppSettings extends UseCase<NoInput, CourierAppSettings, FleetFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'fleet.view-courier-app-settings',
    rule: { kind: 'permissions', allOf: [PROFILE_MANAGE.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: FleetDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext): Outcome<CourierAppSettings> {
    if (courierAccountOf(context) === undefined) return Promise.resolve(err(forbidden()));
    return Promise.resolve(ok(this.deps.rules.courierAppSettings(context.market.marketId)));
  }
}

export interface AddOwnVehicleInput {
  readonly type: VehicleType;
  readonly plate?: string;
  /** Absent: the Market rate card's default for the type. */
  readonly maxWeightGrams?: number;
  /** Absent: the Market rate card's default for the type. */
  readonly maxVolumeLitres?: number;
  readonly coldBox: ColdBox;
}

/**
 * The courier adds a vehicle they deliver with; its registration is a document of its own. A
 * capacity not given is the Market rate card's for the type, and a type the Market does not
 * offer is refused. Rule `permissions [fleet.profile.manage]`.
 */
export class AddOwnVehicle extends UseCase<AddOwnVehicleInput, CourierState, FleetFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'fleet.add-own-vehicle',
    rule: { kind: 'permissions', allOf: [PROFILE_MANAGE.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: FleetDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: AddOwnVehicleInput): Outcome<CourierState> {
    const account = courierAccountOf(context);
    if (account === undefined) return Promise.resolve(err(forbidden()));
    const id = this.deps.ids.next<'Vehicle'>();
    return this.deps.changes.apply(
      context,
      { accountId: account },
      {
        allowed: ownedBy(account),
        decide: (courier, rules) =>
          addVehicle(courier, {
            id,
            type: input.type,
            ...(input.plate === undefined ? {} : { plate: input.plate }),
            coldBox: input.coldBox,
            ...capacityFor(input.type, input, rules),
          }),
      },
    );
  }
}

export interface VehicleRef {
  readonly vehicleId: Id<'Vehicle'>;
}

/** The courier takes one of their vehicles out of use. Rule `permissions [fleet.profile.manage]`. */
export class DeactivateOwnVehicle extends UseCase<VehicleRef, CourierState, FleetFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'fleet.deactivate-own-vehicle',
    rule: { kind: 'permissions', allOf: [PROFILE_MANAGE.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: FleetDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: VehicleRef): Outcome<CourierState> {
    const account = courierAccountOf(context);
    if (account === undefined) return Promise.resolve(err(forbidden()));
    return this.deps.changes.apply(
      context,
      { accountId: account },
      {
        allowed: ownedBy(account),
        decide: (courier) => deactivateVehicle(courier, input.vehicleId),
      },
    );
  }
}

/**
 * The courier submits a document for review (a PDF, JPEG or PNG of at most 10 MB, its type read
 * from the bytes). Rule `permissions [fleet.profile.manage]`.
 */
export class SubmitOwnDocument extends UseCase<
  DocumentUpload,
  SubmittedCourierDocument,
  FleetFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'fleet.submit-own-document',
    rule: { kind: 'permissions', allOf: [PROFILE_MANAGE.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: FleetDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: DocumentUpload): Outcome<SubmittedCourierDocument> {
    const account = courierAccountOf(context);
    if (account === undefined) return Promise.resolve(err(forbidden()));
    return submitCourierDocument(this.deps, context, account, input);
  }
}

export interface DocumentRef {
  readonly documentId: Id<'CourierDocument'>;
}

/** The file of one of the courier's own documents. Rule `permissions [fleet.profile.manage]`. */
export class DownloadOwnDocument extends UseCase<DocumentRef, DocumentFile, FleetFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'fleet.download-own-document',
    rule: { kind: 'permissions', allOf: [PROFILE_MANAGE.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: FleetDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: DocumentRef): Outcome<DocumentFile> {
    const account = courierAccountOf(context);
    if (account === undefined) return Promise.resolve(err(forbidden()));
    return readDocumentFile(
      this.deps,
      context,
      { accountId: account },
      input.documentId,
      ownedBy(account),
    );
  }
}

export interface ShiftInput {
  readonly state: ShiftState;
}

/**
 * The courier goes online or offline, pauses, or starts and ends a delivery. Going online needs
 * a vehicle they are eligible for now. Rule `permissions [fleet.shift.change]`.
 */
export class ChangeOwnShift extends UseCase<ShiftInput, CourierState, FleetFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'fleet.change-own-shift',
    rule: { kind: 'permissions', allOf: [SHIFT_CHANGE.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: FleetDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: ShiftInput): Outcome<CourierState> {
    const account = courierAccountOf(context);
    if (account === undefined) return Promise.resolve(err(forbidden()));
    return this.deps.changes.apply(
      context,
      { accountId: account },
      {
        allowed: ownedBy(account),
        decide: (courier, rules, now) => changeShift(courier, input.state, rules, now),
      },
    );
  }
}
