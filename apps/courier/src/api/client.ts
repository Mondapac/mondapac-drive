import type {
  CourierSession,
  CourierSettings,
  CourierStatus,
  EarningsBalance,
  EarningsSummary,
  FailureReason,
  Job,
  LocationPing,
  Offer,
  ShiftState,
  SignInInput,
  ApplyInput,
  CourierProfile,
  OnboardingRules,
  PayoutOnboardingLink,
  VehicleInput,
} from './schemas';

/** Proof the courier collected at the door. The server checks the PIN, never the app. */
export type ProofInput = { kind: 'pin'; pin: string } | { kind: 'photo'; photoRef: string };

/** What the courier reports about a job. The delivery API enforces the lifecycle. */
export type JobEvent =
  | { type: 'arrived_at_pickup' }
  | { type: 'picked_up'; temperatureCelsius?: number }
  | { type: 'arrived_at_dropoff' }
  | { type: 'delivered'; proof: ProofInput; temperatureCelsius?: number }
  | { type: 'delivery_failed'; reason: FailureReason; details?: string };

/** A photo on the device, already compressed, ready to upload. */
export interface PhotoFile {
  readonly uri: string;
  readonly mimeType: 'image/jpeg';
}

/** A refusal of the API, with its stable code (such as `cold-chain.breach`). */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(`${status} ${code}`);
    this.name = 'ApiError';
  }
}

/**
 * Everything the app asks of the backend. Two adapters implement it: HTTP for the real API and
 * a mock that runs the app and its tests before the backend routes exist.
 */
export interface CourierApi {
  signIn(input: SignInInput): Promise<CourierSession>;
  signOut(): Promise<void>;
  settings(): Promise<CourierSettings>;
  status(): Promise<CourierStatus>;
  setShift(state: Extract<ShiftState, 'online' | 'offline'>): Promise<CourierStatus>;
  currentOffer(): Promise<Offer | null>;
  acceptOffer(offerId: string): Promise<{ deliveryId: string }>;
  declineOffer(offerId: string): Promise<void>;
  job(deliveryId: string): Promise<Job>;
  recordEvent(deliveryId: string, event: JobEvent): Promise<Job>;
  uploadProofPhoto(deliveryId: string, photo: PhotoFile): Promise<{ photoRef: string }>;
  sendPings(pings: readonly LocationPing[]): Promise<void>;
  earnings(): Promise<EarningsSummary>;
  /** The courier's fleet profile; null before the courier has applied (404 from fleet). */
  profile(): Promise<CourierProfile | null>;
  /** The Market's onboarding rules; null while the API does not send them yet. */
  onboardingRules(): Promise<OnboardingRules | null>;
  applyAsCourier(input: ApplyInput): Promise<CourierProfile>;
  addVehicle(input: VehicleInput): Promise<CourierProfile>;
  submitDocument(upload: DocumentUpload): Promise<CourierProfile>;
  payoutOnboardingLink(): Promise<PayoutOnboardingLink>;
  /** The balance and the latest `limit` ledger entries (1 to 200), newest first. */
  balance(limit: number): Promise<EarningsBalance>;
}

/**
 * The delivery the courier accepted, kept on the device: fleet does not report the active
 * delivery yet (`activeDeliveryId` is null), so the app remembers it to return to the job after
 * a restart. The server's answer wins once it has one.
 */
export interface ActiveJobMemory {
  current(): string | null;
  remember(deliveryId: string): Promise<void>;
  forget(): Promise<void>;
}

/** The session the adapters attach to every call (bearer token and `x-market-id`). */
export interface SessionSource {
  current(): CourierSession | null;
}

/** A document file on the device, ready to upload (PDF, or an image re-encoded on the device). */
export interface DocumentFile {
  readonly uri: string;
  readonly name: string;
  readonly mimeType: 'application/pdf' | 'image/jpeg' | 'image/png';
}

/** One document the courier submits for review (`POST /fleet/courier/me/documents`). */
export interface DocumentUpload {
  readonly type: string;
  readonly file: DocumentFile;
  /** For a document of one vehicle, such as its registration. */
  readonly vehicleId?: string;
  /** For a document that expires: an instant with an offset. */
  readonly expiresAt?: string;
}
