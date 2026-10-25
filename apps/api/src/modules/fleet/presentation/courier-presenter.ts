import type { CourierState } from '../domain/courier';
import type { CourierDocument } from '../domain/documents';
import type { Vehicle } from '../domain/vehicle';

// The response shapes of a courier: never a document's object-store key (`fileKey`); instants as
// ISO strings. The identity account id (`actorId`) goes only to operators, as `accountId`, so the
// panel can link fleet, payouts and delivery pages and show the name from identity (handoff 31).

const vehicleBody = (vehicle: Vehicle) => ({
  id: vehicle.id,
  type: vehicle.type,
  plate: vehicle.plate ?? null,
  maxWeightGrams: vehicle.maxWeightGrams,
  maxVolumeLitres: vehicle.maxVolumeLitres,
  coldBox: vehicle.coldBox,
  active: vehicle.active,
});

const documentBody = (document: CourierDocument) => ({
  id: document.id,
  type: document.type,
  vehicleId: document.vehicleId ?? null,
  mediaType: document.mediaType,
  expiresAt: document.expiresAt?.toString() ?? null,
  status: document.status,
  submittedAt: document.submittedAt.toString(),
  reviewedAt: document.reviewedAt?.toString() ?? null,
  rejectionReason: document.rejectionReason ?? null,
});

/** A courier with their vehicles and documents. */
export function courierBody(courier: CourierState) {
  return {
    id: courier.id,
    status: courier.status,
    employmentType: courier.employmentType,
    coldChainCapable: courier.coldChainCapable,
    taxRegistered: courier.taxRegistered,
    serviceAreaCode: courier.serviceAreaCode,
    shift: courier.shift,
    idleSince: courier.idleSince?.toString() ?? null,
    createdAt: courier.createdAt.toString(),
    vehicles: courier.vehicles.map(vehicleBody),
    documents: courier.documents.map(documentBody),
  };
}

/** A row of the panel's courier list. */
export function courierSummaryBody(courier: CourierState) {
  return {
    id: courier.id,
    status: courier.status,
    employmentType: courier.employmentType,
    coldChainCapable: courier.coldChainCapable,
    taxRegistered: courier.taxRegistered,
    serviceAreaCode: courier.serviceAreaCode,
    shift: courier.shift,
    createdAt: courier.createdAt.toString(),
    activeVehicles: courier.vehicles.filter((v) => v.active).length,
    documentsToReview: courier.documents.filter((d) => d.status === 'submitted').length,
  };
}

/** What operators see besides: the identity account id and the delivery the courier carries. */
const operatorFields = (courier: CourierState) => ({
  accountId: courier.actorId,
  activeDeliveryId: courier.activeDeliveryId ?? null,
});

/** A courier as the panel shows it. */
export function adminCourierBody(courier: CourierState) {
  return { ...courierBody(courier), ...operatorFields(courier) };
}

/** A row of the panel's courier list. */
export function adminCourierSummaryBody(courier: CourierState) {
  return { ...courierSummaryBody(courier), ...operatorFields(courier) };
}
