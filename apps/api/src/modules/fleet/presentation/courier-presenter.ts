import type { CourierState } from '../domain/courier';
import type { CourierDocument } from '../domain/documents';
import type { Vehicle } from '../domain/vehicle';

// The response shapes of a courier: never the identity account id (`actorId`) and never a
// document's object-store key (`fileKey`); instants as ISO strings.

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
